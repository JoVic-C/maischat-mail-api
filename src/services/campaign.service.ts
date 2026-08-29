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
import { logger } from '../utils/logger';
import emailService from './email.service';
import segmentService from './segment.service';
import smtpService, { FALLBACK_SMTP_ID } from './smtp.service';

/** Quantos destinatários são materializados por vez ao disparar uma campanha. */
const DISPATCH_BATCH_SIZE = Number(process.env.CAMPAIGN_BATCH_SIZE) || 1000;

/** Projeção mínima de um destinatário — só o que vira job de envio. */
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
    await cancelSchedule(id); // remove agendamento pendente, se houver
    const drained = await removeCampaignJobs(id); // drena os envios que ainda estão na fila
    if (drained) logger.info(`🧹 ${drained} envio(s) pendente(s) removido(s) da fila da campanha ${id}`);
    await SendLog.deleteMany({ campaignId: id });
    await campaign.deleteOne();
  }

  /** Logs de envio paginados — uma campanha grande tem centenas de milhares de linhas. */
  async getLogs(
    campaignId: string,
    opts: { page?: number; limit?: number; status?: string } = {}
  ): Promise<CampaignLogsResult> {
    await this.getById(campaignId);

    // O default de 500 preserva o comportamento anterior (limit fixo de 500) para
    // quem chama sem paginar — o frontend atual depende disso.
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

    // SMTP do cliente (o escolhido ou o padrão). Se não houver, cai no xMailer embutido.
    const custom = campaign.smtpId
      ? await SmtpSettings.findById(campaign.smtpId)
      : await SmtpSettings.findOne({ isDefault: true });
    if (!custom && !smtpService.getFallbackSmtp()) {
      throw new BadRequestError('Nenhum servidor SMTP configurado e o xMailer padrão não está definido.');
    }
    const smtpIdForJob = custom ? String(custom._id) : FALLBACK_SMTP_ID;

    // Filtro opcional de segmento: intersecta as listas com as regras do segmento.
    let segmentQuery: Record<string, unknown> = {};
    if (campaign.segmentId) {
      const segment = await Segment.findById(campaign.segmentId);
      if (segment) segmentQuery = segmentService.buildQuery(segment);
    }

    const recipientQuery = {
      lists: { $in: campaign.listIds },
      status: 'active',
      // Escopo "só entregues": reenvia apenas para quem já recebeu com sucesso antes.
      ...(opts.onlyDelivered ? { lastDeliveredAt: { $ne: null } } : {}),
      ...segmentQuery,
    };

    const total = await Contact.countDocuments(recipientQuery);
    if (!total) {
      throw new BadRequestError(await this.explicarPublicoVazio(campaign.listIds, opts, segmentQuery));
    }

    const attachments = campaign.attachments.map((a) => ({ filename: a.filename, storedName: a.storedName }));

    // Recomeço limpo: remove os envios anteriores (evita E11000 no índice único {campaignId,contactId})
    // e zera as métricas herdadas de uma execução anterior.
    await SendLog.deleteMany({ campaignId: campaign._id });
    campaign.stats.sent = 0;
    campaign.stats.failed = 0;
    campaign.stats.bounced = 0;
    campaign.stats.opened = 0;
    campaign.stats.clicked = 0;
    campaign.stats.unsubscribed = 0;
    campaign.linkStats.splice(0);

    campaign.status = 'sending';
    campaign.startedAt = new Date();
    campaign.scheduledAt = null; // se veio de um agendamento, limpa a marca
    campaign.stats.total = total; // definido ANTES de enfileirar, senão o finalize dispararia cedo
    await campaign.save();

    // Percorre os destinatários por cursor e despacha em lotes: uma lista de centenas de
    // milhares de contatos não cabe em memória de uma vez (nem como docs, nem como jobs).
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
      // Enfileiramento interrompido no meio: pausa a campanha em vez de deixá-la
      // 'sending' com menos jobs do que o total (que nunca completaria).
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

  /**
   * Explica POR QUE não sobrou ninguém para receber.
   *
   * Antes a recusa era sempre "Nenhum contato ativo nas listas", o que manda o usuário
   * procurar no lugar errado quando o público foi zerado por um filtro — o caso comum
   * é escolher "só quem já recebeu antes" numa lista que nunca recebeu nada.
   * Cada checagem abaixo é uma contagem barata e só roda no caminho de erro.
   */
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

    // Há ativos: o que zerou foi um dos filtros. Descobre qual para dizer o certo.
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

    // Chegar aqui significa que a contagem mudou entre as duas queries (importação
    // simultânea, por exemplo) — melhor ser honesto do que inventar um motivo.
    return 'Nenhum contato elegível para esta campanha no momento.';
  }

  /** Cria os SendLog e enfileira os jobs de um lote de destinatários. */
  private async dispatchBatch(
    campaign: CampaignDocument,
    contacts: RecipientRow[],
    template: { subject: string; html: string },
    smtpIdForJob: string,
    attachments: { filename: string; storedName: string }[]
  ): Promise<number> {
    // Um insertMany por lote (evita N+1 de milhares de inserts seriais).
    const logs = await SendLog.insertMany(
      contacts.map((contact) => ({
        campaignId: campaign._id,
        contactId: contact._id,
        email: contact.email,
        status: 'pending' as const,
      }))
    );

    const jobs: EmailJob[] = contacts.map((contact, i) => ({
      tenantId: String(campaign.tenantId),
      campaignId: String(campaign._id),
      sendLogId: String(logs[i]._id),
      smtpId: smtpIdForJob,
      to: contact.email,
      subjectTemplate: template.subject,
      htmlTemplate: template.html,
      data: {
        name: contact.name,
        email: contact.email,
        company: contact.company,
        // .lean() devolve metadata como objeto puro — espalha direto.
        ...(contact.metadata ?? {}),
      },
      attachments,
    }));

    await enqueueEmails(jobs);
    return jobs.length;
  }

  /** Agenda o disparo para uma data futura (cria um job atrasado na fila do scheduler). */
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

    await cancelSchedule(id); // remove agendamento anterior, se houver
    await scheduleCampaign(String(campaign.tenantId), id, delayMs); // job atrasado (dispara start() na hora)
    campaign.status = 'scheduled';
    campaign.scheduledAt = scheduledAt;
    await campaign.save();
    return { scheduledAt };
  }

  /** Cancela um agendamento e volta a campanha para rascunho. */
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

  /** Envia UM email de teste (sem tracking) para validar o visual antes do disparo. */
  async sendTest(id: string, toEmail: string): Promise<{ to: string }> {
    const campaign = await this.getById(id);

    const template = await Template.findById(campaign.templateId);
    if (!template) throw new BadRequestError('Template da campanha não encontrado.');

    const smtp =
      (campaign.smtpId
        ? await SmtpSettings.findById(campaign.smtpId)
        : await SmtpSettings.findOne({ isDefault: true })) ?? smtpService.getFallbackSmtp(); // cai no xMailer se não houver SMTP próprio
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

  /** Pausa UMA campanha em envio. O worker adia os jobs enquanto ela estiver 'paused'. */
  async pause(id: string): Promise<void> {
    const campaign = await this.getById(id);
    if (campaign.status !== 'sending') {
      throw new BadRequestError('Só é possível pausar uma campanha em envio.');
    }
    campaign.status = 'paused';
    await campaign.save();
  }

  /** Retoma uma campanha pausada: o worker volta a processar os jobs adiados. */
  async resume(id: string): Promise<void> {
    const campaign = await this.getById(id);
    if (campaign.status !== 'paused') {
      throw new BadRequestError('A campanha não está pausada.');
    }
    campaign.status = 'sending';
    await campaign.save();
  }
}

export default new CampaignService();
