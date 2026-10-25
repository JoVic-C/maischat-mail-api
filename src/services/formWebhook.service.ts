import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { redisConnection } from '../config/redis';
import { BadRequestError, NotFoundError } from '../errors';
import Contact from '../models/Contact';
import FormSubmission, { type IFormSubmission } from '../models/FormSubmission';
import FormWebhook, { type FormWebhookDocument, type FormWebhookStats } from '../models/FormWebhook';
import SmtpSettings from '../models/SmtpSettings';
import Template from '../models/Template';
import { enqueueFormEmail } from '../queue/formEmail.queue';
import { reserveSmtpQuota } from '../queue/smtpQuota';
import { emailDomainHasMail } from '../utils/emailHygiene';
import { extractFields, type FormFields, pickEmail, pickName } from '../utils/formFields';
import { garantirHtmlEnviavel } from '../utils/htmlEscapado';
import emailService from './email.service';
import emailVerificationService from './emailVerification.service';
import sendingDomainService from './sendingDomain.service';
import smtpService, { FALLBACK_SMTP_ID } from './smtp.service';

export interface SaveFormWebhookInput {
  id?: string;
  name: string;
  templateId: string;
  smtpId?: string | null;
  emailField?: string;
  nameField?: string;
  hourlyLimit?: number;
  redirectUrl?: string;
  isActive?: boolean;
}

export interface FormWebhookView {
  id: string;
  name: string;
  templateId: string;
  templateName: string;
  smtpId: string | null;
  emailField: string;
  nameField: string;
  hourlyLimit: number;
  redirectUrl: string;
  isActive: boolean;
  url: string;
  stats: FormWebhookStats;
  lastReceivedAt: Date | null;
  createdAt: Date;
}

export interface PublicWebhook {
  id: string;
  tenantId: string;
  redirectUrl: string;
}

export type ReceiveOutcome =
  | { kind: 'queued'; submissionId: string }
  | { kind: 'duplicate' }
  | { kind: 'ignored' }
  | { kind: 'rejected'; status: 422 | 429; message: string };

export type DeliverOutcome = { kind: 'done' } | { kind: 'retry-after'; ms: number };

type SubmissionBase = Pick<IFormSubmission, 'email' | 'name' | 'fields' | 'ip'> & { webhookId: Types.ObjectId };

const DEDUPE_SECONDS = 10 * 60;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{20,100}$/;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function webhookUrl(token: string): string {
  const base = (process.env.PUBLIC_API_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/api/hooks/forms/${token}`;
}

function newTokenFields(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export class FormWebhookService {
  async list(): Promise<FormWebhookView[]> {
    const hooks = await FormWebhook.find().sort({ createdAt: -1 });
    const templates = await Template.find({ _id: { $in: hooks.map((h) => h.templateId) } }, { name: 1 }).lean();
    const names = new Map(templates.map((t) => [String(t._id), t.name]));
    return hooks.map((hook) => this.toView(hook, names.get(String(hook.templateId)) ?? ''));
  }

  async getById(id: string): Promise<FormWebhookDocument> {
    const hook = await FormWebhook.findById(id);
    if (!hook) throw new NotFoundError('Webhook não encontrado.');
    return hook;
  }

  async save(data: SaveFormWebhookInput): Promise<FormWebhookView> {
    const template = await Template.findById(data.templateId, { name: 1 }).lean();
    if (!template) throw new BadRequestError('Template não encontrado.');
    if (data.smtpId && !(await SmtpSettings.exists({ _id: data.smtpId }))) {
      throw new BadRequestError('Servidor SMTP não encontrado.');
    }

    const hook = data.id ? await this.getById(data.id) : new FormWebhook(newTokenFields());
    hook.name = data.name;
    hook.templateId = new Types.ObjectId(data.templateId);
    hook.smtpId = data.smtpId ? new Types.ObjectId(data.smtpId) : null;
    hook.emailField = data.emailField ?? '';
    hook.nameField = data.nameField ?? '';
    hook.redirectUrl = data.redirectUrl ?? '';
    if (data.hourlyLimit !== undefined) hook.hourlyLimit = data.hourlyLimit;
    if (data.isActive !== undefined) hook.isActive = data.isActive;
    await hook.save();

    return this.toView(hook, template.name);
  }

  async regenerate(id: string): Promise<FormWebhookView> {
    const hook = await this.getById(id);
    const { token, tokenHash } = newTokenFields();
    hook.token = token;
    hook.tokenHash = tokenHash;
    await hook.save();
    const template = await Template.findById(hook.templateId, { name: 1 }).lean();
    return this.toView(hook, template?.name ?? '');
  }

  async remove(id: string): Promise<void> {
    const hook = await this.getById(id);
    await FormSubmission.deleteMany({ webhookId: hook._id });
    await hook.deleteOne();
  }

  async submissions(id: string, limit = 50): Promise<IFormSubmission[]> {
    const hook = await this.getById(id);
    return FormSubmission.find({ webhookId: hook._id }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  /** Roda em modo system: a URL pública ainda não diz de qual cliente é o webhook. */
  async findByToken(token: string): Promise<PublicWebhook | null> {
    if (!TOKEN_FORMAT.test(token)) return null;
    const hook = await FormWebhook.findOne(
      { tokenHash: hashToken(token) },
      { tenantId: 1, isActive: 1, redirectUrl: 1 }
    ).lean();
    if (!hook?.isActive || !hook.tenantId) return null;
    return { id: String(hook._id), tenantId: String(hook.tenantId), redirectUrl: hook.redirectUrl };
  }

  async receive(webhookId: string, body: unknown, ip: string): Promise<ReceiveOutcome> {
    const hook = await this.getById(webhookId);
    const { fields, honeypot } = extractFields(body);
    // Robô não recebe pista de que foi descartado.
    if (honeypot) return { kind: 'ignored' };

    const email = pickEmail(fields, hook.emailField);
    const base: SubmissionBase = {
      webhookId: hook._id,
      email: email ?? '',
      name: pickName(fields, hook.nameField),
      fields,
      ip,
    };

    if (!email) {
      const reason = hook.emailField
        ? `O campo "${hook.emailField}" não trouxe um email válido.`
        : 'Nenhum email válido encontrado nos campos enviados.';
      await this.reject(hook, base, reason);
      return { kind: 'rejected', status: 422, message: reason };
    }

    if (!(await this.withinHourlyLimit(hook))) {
      const reason = `Limite de ${hook.hourlyLimit} envios por hora atingido.`;
      await this.reject(hook, base, reason);
      return { kind: 'rejected', status: 429, message: reason };
    }

    if (!(await this.firstInWindow(hook, email))) return { kind: 'duplicate' };

    const submission = await FormSubmission.create({ ...base, status: 'queued' });
    await FormWebhook.updateOne(
      { _id: hook._id },
      { $set: { lastReceivedAt: new Date() }, $inc: { 'stats.received': 1 } }
    );
    await enqueueFormEmail({ tenantId: String(hook.tenantId), submissionId: String(submission._id) });
    return { kind: 'queued', submissionId: String(submission._id) };
  }

  async deliver(submissionId: string): Promise<DeliverOutcome> {
    const submission = await FormSubmission.findById(submissionId);
    if (submission?.status !== 'queued') return { kind: 'done' };

    const hook = await FormWebhook.findById(submission.webhookId);
    if (!hook) return this.fail(submissionId, 'O webhook foi excluído antes do envio.');

    const template = await Template.findById(hook.templateId).lean();
    if (!template) return this.fail(submissionId, 'O template do webhook não existe mais.');
    try {
      garantirHtmlEnviavel(template.html);
    } catch (err) {
      return this.fail(submissionId, (err as Error).message);
    }

    if (await Contact.exists({ email: submission.email, status: 'bounced' })) {
      return this.fail(submissionId, 'Endereço com bounce registrado: o email não foi enviado.');
    }
    if (!(await emailDomainHasMail(submission.email))) {
      return this.fail(submissionId, 'O domínio do email não existe ou não recebe mensagens: o email não foi enviado.');
    }

    const custom = hook.smtpId
      ? await SmtpSettings.findById(hook.smtpId)
      : await SmtpSettings.findOne({ isDefault: true });
    if (hook.smtpId && !custom) return this.fail(submissionId, 'O servidor SMTP do webhook não existe mais.');
    const smtp = custom ?? smtpService.getFallbackSmtp();
    if (!smtp) return this.fail(submissionId, 'Nenhum servidor SMTP configurado.');

    if (custom) {
      try {
        await sendingDomainService.assertSendable(custom);
      } catch (err) {
        return this.fail(submissionId, (err as Error).message);
      }
    }

    const quota = await reserveSmtpQuota(
      custom ? String(custom._id) : FALLBACK_SMTP_ID,
      smtp.dailyLimit,
      smtp.hourlyLimit
    );
    if (!quota.ok) return { kind: 'retry-after', ms: quota.retryAfterMs };

    // Depois da cota do SMTP: a espera por cota reentra aqui, e verificar antes cobraria de novo.
    const mailboxProblem = await this.mailboxProblem(submission.email);
    if (mailboxProblem) return this.fail(submissionId, mailboxProblem);

    const fields = (submission.fields ?? {}) as FormFields;
    const result = await emailService.send({
      smtp,
      to: submission.email,
      subjectTemplate: template.subject,
      htmlTemplate: template.html,
      data: { ...fields, name: submission.name || fields.name || '', email: submission.email },
      campaignId: `form-${hook._id}`,
      sendLogId: String(submission._id),
      skipTracking: true,
    });

    submission.status = 'sent';
    submission.reason = '';
    submission.messageId = result.messageId;
    submission.sentAt = new Date();
    await submission.save();
    await FormWebhook.updateOne({ _id: hook._id }, { $inc: { 'stats.sent': 1 } });
    return { kind: 'done' };
  }

  async markFailed(submissionId: string, reason: string): Promise<void> {
    const submission = await FormSubmission.findOneAndUpdate(
      { _id: submissionId, status: 'queued' },
      { status: 'failed', reason },
      { new: true }
    );
    if (submission) await FormWebhook.updateOne({ _id: submission.webhookId }, { $inc: { 'stats.failed': 1 } });
  }

  /** Usa a verificação do contato, se recente; senão consulta o provedor e guarda no contato. */
  private async mailboxProblem(email: string): Promise<string | null> {
    const contact = await Contact.findOne({ email }).select('verification');
    let verification = emailVerificationService.isFresh(contact?.verification) ? contact?.verification : null;

    if (!verification) {
      verification = await emailVerificationService.verifySingle(email);
      if (verification && contact) {
        contact.verification = verification;
        await contact.save();
      }
    }

    if (verification?.status !== 'undeliverable') return null;
    return `Caixa postal reprovada na verificação (${emailVerificationService.describe(verification)}): o email não foi enviado.`;
  }

  private async fail(submissionId: string, reason: string): Promise<DeliverOutcome> {
    await this.markFailed(submissionId, reason);
    return { kind: 'done' };
  }

  private async reject(hook: FormWebhookDocument, base: SubmissionBase, reason: string): Promise<void> {
    await FormSubmission.create({ ...base, status: 'rejected', reason });
    await FormWebhook.updateOne(
      { _id: hook._id },
      { $set: { lastReceivedAt: new Date() }, $inc: { 'stats.received': 1, 'stats.rejected': 1 } }
    );
  }

  private async withinHourlyLimit(hook: FormWebhookDocument): Promise<boolean> {
    const hour = new Date().toISOString().slice(0, 13).replace(/\D/g, '');
    const key = `formhook:${hook._id}:h:${hour}`;
    const used = await redisConnection.incr(key);
    if (used === 1) await redisConnection.expire(key, 3700);
    return used <= hook.hourlyLimit;
  }

  private async firstInWindow(hook: FormWebhookDocument, email: string): Promise<boolean> {
    const key = `formhook:${hook._id}:dup:${hashToken(email)}`;
    return (await redisConnection.set(key, '1', 'EX', DEDUPE_SECONDS, 'NX')) === 'OK';
  }

  private toView(hook: FormWebhookDocument, templateName: string): FormWebhookView {
    return {
      id: String(hook._id),
      name: hook.name,
      templateId: String(hook.templateId),
      templateName,
      smtpId: hook.smtpId ? String(hook.smtpId) : null,
      emailField: hook.emailField,
      nameField: hook.nameField,
      hourlyLimit: hook.hourlyLimit,
      redirectUrl: hook.redirectUrl,
      isActive: hook.isActive,
      url: webhookUrl(hook.token),
      stats: {
        received: hook.stats?.received ?? 0,
        sent: hook.stats?.sent ?? 0,
        failed: hook.stats?.failed ?? 0,
        rejected: hook.stats?.rejected ?? 0,
      },
      lastReceivedAt: hook.lastReceivedAt ?? null,
      createdAt: hook.createdAt,
    };
  }
}

export default new FormWebhookService();
