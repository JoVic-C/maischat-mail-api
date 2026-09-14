import { Types } from 'mongoose';
import { BadRequestError, NotFoundError } from '../errors';
import Campaign, { type CampaignDocument, type ICampaign } from '../models/Campaign';
import Contact from '../models/Contact';
import Segment from '../models/Segment';
import SendLog from '../models/SendLog';
import SmtpSettings from '../models/SmtpSettings';
import Template from '../models/Template';
import { type EmailJob, enqueueEmails, removeCampaignJobs } from '../queue/email.queue';
import { cancelSchedule, scheduleCampaign } from '../queue/scheduler.queue';
import { garantirHtmlEnviavel } from '../utils/htmlEscapado';
import { logger } from '../utils/logger';
import emailService from './email.service';
import segmentService from './segment.service';
import sendingDomainService from './sendingDomain.service';
import smtpService, { FALLBACK_SMTP_ID } from './smtp.service';

const DISPATCH_BATCH_SIZE = Number(process.env.CAMPAIGN_BATCH_SIZE) || 1000;

interface RecipientRow {
  _id: Types.ObjectId;
  email: string;
  name: string;
  company: string;
  metadata?: Record<string, string>;
}

export interface CampaignLogsResult {
  logs: unknown[];
  total: number;
  page: number;
  limit: number;
}

export interface SaveCampaignInput {
  id?: string;
  name: string;
  templateId: string;
  listIds: string[];
  smtpId?: string | null;
  segmentId?: string | null;
  attachments?: { filename: string; storedName: string; size: number }[];
}

export class CampaignService {
  async list(): Promise<ICampaign[]> {
    return Campaign.find().sort({ createdAt: -1 }).lean();
  }

  async getById(id: string): Promise<CampaignDocument> {
    const campaign = await Campaign.findById(id);
    if (!campaign) throw new NotFoundError('Campanha não encontrada.');
    return campaign;
  }

  async save(data: SaveCampaignInput): Promise<CampaignDocument> {
    if (data.id) {
      const campaign = await this.getById(data.id);
      if (campaign.status === 'sending') {
        throw new BadRequestError('Não é possivel editar uma campanha em envio.');
      }
      campaign.name = data.name;
      campaign.templateId = new Types.ObjectId(data.templateId);
      campaign.listIds = data.listIds.map((l) => new Types.ObjectId(l));
      campaign.smtpId = data.smtpId ? new Types.ObjectId(data.smtpId) : null;
      campaign.segmentId = data.segmentId ? new Types.ObjectId(data.segmentId) : null;
      campaign.attachments = data.attachments ?? [];
      return campaign.save();
    }

    return Campaign.create({
      name: data.name,
      templateId: data.templateId,
      listIds: data.listIds,
      smtpId: data.smtpId ?? null,
      segmentId: data.segmentId ?? null,
      attachments: data.attachments ?? [],
    });
  }

  async remove(id: string): Promise<void> {
    const campaign = await this.getById(id);
    if (campaign.status === 'sending') {
      throw new BadRequestError('Não é possível excluir uma campanha em envio');
    }
    await cancelSchedule(id);
    const drained = await removeCampaignJobs(id);
    if (drained) logger.info(`🧹 ${drained} envio(s) pendente(s) removido(s) da fila da campanha ${id}`);
    await SendLog.deleteMany({ campaignId: id });
    await campaign.deleteOne();
  }

  async getLogs(
    campaignId: string,
    opts: { page?: number; limit?: number; status?: string } = {}
  ): Promise<CampaignLogsResult> {
    await this.getById(campaignId);

    // O painel chama sem paginar e depende do padrão de 500.
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(500, Math.max(1, opts.limit ?? 500));
    const query: Record<string, unknown> = { campaignId };
    if (opts.status) query.status = opts.status;

    const [logs, total] = await Promise.all([
      SendLog.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SendLog.countDocuments(query),
    ]);
    return { logs, total, page, limit };
  }

  async start(id: string, opts: { onlyDelivered?: boolean } = {}): Promise<{ queued: number }> {
    const campaign = await this.getById(id);

    if (['sending', 'queued'].includes(campaign.status)) {
      throw new BadRequestError('Campanha já está em envio.');
    }
    if (campaign.status === 'paused') {
      throw new BadRequestError('Campanha pausada — use "retomar" em vez de iniciar.');
    }
    if (!campaign.listIds.length) {
      throw new BadRequestError('Campanha sem listas de destinatários.');
    }

    const template = await Template.findById(campaign.templateId);
    if (!template) throw new BadRequestError('Template da campanha não encontrado.');
    garantirHtmlEnviavel(template.html);

    const custom = campaign.smtpId
      ? await SmtpSettings.findById(campaign.smtpId)
      : await SmtpSettings.findOne({ isDefault: true });
    if (!custom && !smtpService.getFallbackSmtp()) {
      throw new BadRequestError('Nenhum servidor SMTP configurado e o xMailer padrão não está definido.');
    }
    if (custom) await sendingDomainService.assertSendable(custom);
    const smtpIdForJob = custom ? String(custom._id) : FALLBACK_SMTP_ID;

    let segmentQuery: Record<string, unknown> = {};
    if (campaign.segmentId) {
      const segment = await Segment.findById(campaign.segmentId);
      if (segment) segmentQuery = segmentService.buildQuery(segment);
    }

    const recipientQuery = {
      lists: { $in: campaign.listIds },
      status: 'active',
      ...(opts.onlyDelivered ? { lastDeliveredAt: { $ne: null } } : {}),
      ...segmentQuery,
    };

    const total = await Contact.countDocuments(recipientQuery);
    if (!total) {
      throw new BadRequestError(await this.explicarPublicoVazio(campaign.listIds, opts, segmentQuery));
    }

    const attachments = campaign.attachments.map((a) => ({ filename: a.filename, storedName: a.storedName }));

    // Remove os envios anteriores (índice único {campaignId, contactId}) e zera as métricas.
    await SendLog.deleteMany({ campaignId: campaign._id });
    campaign.stats.sent = 0;
    campaign.stats.failed = 0;
    campaign.stats.bounced = 0;
    campaign.stats.opened = 0;
    campaign.stats.clicked = 0;
    campaign.stats.unsubscribed = 0;
    campaign.linkStats.splice(0);

    campaign.snapshot = { subject: template.subject, html: template.html };
    campaign.status = 'sending';
    campaign.startedAt = new Date();
    campaign.scheduledAt = null;
    // Antes de enfileirar, senão o finalizeIfDone concluiria a campanha cedo.
    campaign.stats.total = total;
    await campaign.save();

    let queued = 0;
    let batch: RecipientRow[] = [];
    try {
      const cursor = Contact.find(recipientQuery)
        .select('email name company metadata')
        .lean<RecipientRow[]>()
        .cursor({ batchSize: DISPATCH_BATCH_SIZE });

      for await (const contact of cursor) {
        batch.push(contact as RecipientRow);
        if (batch.length >= DISPATCH_BATCH_SIZE) {
          queued += await this.dispatchBatch(campaign, batch, template, smtpIdForJob, attachments);
          batch = [];
        }
      }
      if (batch.length) {
        queued += await this.dispatchBatch(campaign, batch, template, smtpIdForJob, attachments);
      }
    } catch (err) {
      // Com menos jobs que o total a campanha nunca concluiria; pausa em vez disso.
      campaign.status = 'paused';
      campaign.stats.total = queued;
      await campaign.save();
      logger.error('campaign.start.dispatch falhou — campanha pausada', {
        campaignId: String(campaign._id),
        queued,
        message: (err as Error).message,
      });
      throw err;
    }

    return { queued };
  }

  /** Diz qual filtro zerou o público; só roda no caminho de erro. */
  private async explicarPublicoVazio(
    listIds: Types.ObjectId[],
    opts: { onlyDelivered?: boolean },
    segmentQuery: Record<string, unknown>
  ): Promise<string> {
    const nasListas = await Contact.countDocuments({ lists: { $in: listIds } });
    if (!nasListas) return 'As listas selecionadas não têm nenhum contato.';

    const ativos = await Contact.countDocuments({ lists: { $in: listIds }, status: 'active' });
    if (!ativos) {
      return `Os ${nasListas} contato(s) das listas estão bloqueados por bounce ou descadastro — nenhum pode receber.`;
    }

    const temSegmento = Object.keys(segmentQuery).length > 0;
    if (temSegmento) {
      const comSegmento = await Contact.countDocuments({
        lists: { $in: listIds },
        status: 'active',
        ...segmentQuery,
      });
      if (!comSegmento) {
        return `O segmento aplicado não encontrou nenhum dos ${ativos} contato(s) ativos destas listas.`;
      }
    }

    if (opts.onlyDelivered) {
      return (
        `Nenhum dos ${ativos} contato(s) ativos já recebeu um envio antes. ` +
        'Escolha "Todos os contatos das listas" para incluí-los.'
      );
    }

    // A contagem mudou entre as consultas (importação simultânea, por exemplo).
    return 'Nenhum contato elegível para esta campanha no momento.';
  }

  private async dispatchBatch(
    campaign: CampaignDocument,
    contacts: RecipientRow[],
    template: { subject: string; html: string },
    smtpIdForJob: string,
    attachments: { filename: string; storedName: string }[]
  ): Promise<number> {
    const logs = await SendLog.insertMany(
      contacts.map((contact) => ({
        campaignId: campaign._id,
        contactId: contact._id,
        email: contact.email,
        status: 'pending' as const,
      }))
    );

    // O conteúdo não viaja no job: o worker lê o snapshot da campanha.
    const jobs: EmailJob[] = contacts.map((contact, i) => ({
      tenantId: String(campaign.tenantId),
      campaignId: String(campaign._id),
      sendLogId: String(logs[i]._id),
      smtpId: smtpIdForJob,
      to: contact.email,
      data: {
        name: contact.name,
        email: contact.email,
        company: contact.company,
        ...(contact.metadata ?? {}),
      },
    }));

    await enqueueEmails(jobs);
    return jobs.length;
  }

  async schedule(id: string, scheduledAt: Date): Promise<{ scheduledAt: Date }> {
    const campaign = await this.getById(id);
    if (['sending', 'queued'].includes(campaign.status)) {
      throw new BadRequestError('Campanha já está em envio.');
    }
    if (!campaign.listIds.length) {
      throw new BadRequestError('Campanha sem listas de destinatários.');
    }
    const delayMs = scheduledAt.getTime() - Date.now();
    if (Number.isNaN(delayMs) || delayMs <= 0) {
      throw new BadRequestError('A data de agendamento deve ser no futuro.');
    }

    await cancelSchedule(id);
    await scheduleCampaign(String(campaign.tenantId), id, delayMs);
    campaign.status = 'scheduled';
    campaign.scheduledAt = scheduledAt;
    await campaign.save();
    return { scheduledAt };
  }

  async unschedule(id: string): Promise<void> {
    const campaign = await this.getById(id);
    if (campaign.status !== 'scheduled') {
      throw new BadRequestError('Campanha não está agendada.');
    }
    await cancelSchedule(id);
    campaign.status = 'draft';
    campaign.scheduledAt = null;
    await campaign.save();
  }

  /** Um email sem tracking, para conferir o visual antes do disparo. */
  async sendTest(id: string, toEmail: string): Promise<{ to: string }> {
    const campaign = await this.getById(id);

    const template = await Template.findById(campaign.templateId);
    if (!template) throw new BadRequestError('Template da campanha não encontrado.');
    garantirHtmlEnviavel(template.html);

    const smtp =
      (campaign.smtpId
        ? await SmtpSettings.findById(campaign.smtpId)
        : await SmtpSettings.findOne({ isDefault: true })) ?? smtpService.getFallbackSmtp();
    if (!smtp) throw new BadRequestError('Nenhum servidor SMTP configurado e o xMailer padrão não está definido.');

    await emailService.send({
      smtp,
      to: toEmail,
      subjectTemplate: template.subject,
      htmlTemplate: template.html,
      data: { name: 'Você', email: toEmail, company: 'Sua Empresa', plano: 'Pro' },
      attachments: campaign.attachments.map((a) => ({ filename: a.filename, storedName: a.storedName })),
      campaignId: String(campaign._id),
      sendLogId: 'test',
      skipTracking: true,
    });

    return { to: toEmail };
  }

  async pause(id: string): Promise<void> {
    const campaign = await this.getById(id);
    if (campaign.status !== 'sending') {
      throw new BadRequestError('Só é possível pausar uma campanha em envio.');
    }
    campaign.status = 'paused';
    await campaign.save();
  }

  async resume(id: string): Promise<void> {
    const campaign = await this.getById(id);
    if (campaign.status !== 'paused') {
      throw new BadRequestError('A campanha não está pausada.');
    }
    campaign.status = 'sending';
    campaign.pauseReason = null;
    await campaign.save();
  }
}

export default new CampaignService();
