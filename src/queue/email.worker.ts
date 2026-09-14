import { DelayedError, type Job, Worker } from 'bullmq';
import { redisConnection } from '../config/redis';
import { captureError } from '../config/sentry';
import { closeSettingsBus, subscribeSettingsChanged } from '../config/settingsBus';
import { runWithTenant } from '../config/tenantContext';
import Campaign from '../models/Campaign';
import Contact from '../models/Contact';
import SendLog from '../models/SendLog';
import SmtpSettings from '../models/SmtpSettings';
import Tenant from '../models/Tenant';
import bounceService from '../services/bounce.service';
import emailService from '../services/email.service';
import platformSettingsService, { type EngineSettings } from '../services/platformSettings.service';
import smtpService, { FALLBACK_SMTP_ID } from '../services/smtp.service';
import { logger, logSideEffect } from '../utils/logger';
import { EMAIL_QUEUE_NAME, type EmailJob } from './email.queue';
import { reserveSmtpQuota } from './smtpQuota';
import { acquireTenantSlot, releaseTenantSlot, reserveTenantRate } from './tenantQuota';

/**
 * Marca a campanha como concluída quando todos os envios terminaram. O filtro por
 * status 'sending' faz com que só um worker execute a transição.
 */
async function finalizeIfDone(campaignId: string): Promise<void> {
  const res = await Campaign.updateOne(
    {
      _id: campaignId,
      status: 'sending',
      $expr: { $gte: [{ $add: ['$stats.sent', '$stats.failed', '$stats.bounced'] }, '$stats.total'] },
    },
    { status: 'completed', completedAt: new Date() }
  );
  if (res.modifiedCount > 0) logger.info(`🏁 Campaign ${campaignId} completed`);
}

function isHardBounce(err: unknown): boolean {
  const code = (err as { responseCode?: number })?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

/** Falha de login no SMTP é do remetente: não pode marcar o contato como bounce. */
function isAuthError(err: unknown): boolean {
  const code = (err as { responseCode?: number })?.responseCode;
  const msg = ((err as Error)?.message || '').toLowerCase();
  return (
    code === 535 ||
    code === 534 ||
    code === 530 ||
    msg.includes('invalid login') ||
    msg.includes('authentication') ||
    msg.includes('username and password not accepted')
  );
}

const MAX_ERRORS = Number(process.env.CAMPAIGN_MAX_ERRORS) || 100;

async function autoPauseIfTooManyErrors(campaignId: string): Promise<void> {
  const res = await Campaign.updateOne(
    {
      _id: campaignId,
      status: 'sending',
      $expr: { $gte: [{ $add: ['$stats.failed', '$stats.bounced'] }, MAX_ERRORS] },
    },
    { status: 'paused', pauseReason: `Pausada automaticamente: ${MAX_ERRORS} envios com erro.` }
  );
  if (res.modifiedCount > 0) {
    logger.warn(`⏸  Campaign ${campaignId} AUTO-PAUSED: errors exceeded ${MAX_ERRORS} (SMTP issue?)`);
  }
}

/**
 * Pausa na primeira falha de login: se falhou para um destinatário, vai falhar para
 * todos. O filtro por status 'sending' torna a chamada idempotente entre envios
 * simultâneos.
 */
async function pauseForSmtpAuth(campaignId: string, detail: string): Promise<void> {
  const res = await Campaign.updateOne(
    { _id: campaignId, status: 'sending' },
    {
      status: 'paused',
      pauseReason: 'Falha de login no servidor SMTP. Corrija usuário e senha na tela de SMTP e retome a campanha.',
    }
  );
  if (res.modifiedCount > 0) {
    logger.warn(`⏸  Campaign ${campaignId} PAUSED on SMTP auth failure: ${detail}`);
  }
}

/** Intervalo de recheck de um job em campanha pausada; é também a latência do "retomar". */
const PAUSE_RECHECK_MS = 4000;

const SLOT_RECHECK_MS = 2000;

/** Sem teto, uma campanha pausada e nunca retomada deixaria jobs reciclando no Redis. */
const MAX_PAUSE_WAIT_MS = Number(process.env.CAMPAIGN_MAX_PAUSE_WAIT_MS) || 24 * 60 * 60 * 1000;

async function markFailed(campaignId: string, sendLogId: string, reason: string): Promise<void> {
  await SendLog.updateOne({ _id: sendLogId }, { status: 'failed', error: reason });
  await Campaign.updateOne({ _id: campaignId }, { $inc: { 'stats.failed': 1 } });
  await finalizeIfDone(campaignId);
  await autoPauseIfTooManyErrors(campaignId);
}

interface ConteudoCampanha {
  subject: string;
  html: string;
  attachments: { filename: string; storedName: string }[];
}

/**
 * Cache do conteúdo por campanha, para não reler o HTML a cada envio. A chave inclui o
 * `startedAt`: reiniciar a campanha gera snapshot novo e invalida a entrada.
 */
const conteudoPorCampanha = new Map<string, ConteudoCampanha>();

const MAX_CAMPANHAS_EM_CACHE = 20;

async function carregarConteudo(campaignId: string, versao: string): Promise<ConteudoCampanha | null> {
  const chave = `${campaignId}:${versao}`;
  const emCache = conteudoPorCampanha.get(chave);
  if (emCache) return emCache;

  const doc = await Campaign.findById(campaignId).select('snapshot attachments').lean();
  if (!doc?.snapshot) return null;

  const conteudo: ConteudoCampanha = {
    subject: doc.snapshot.subject,
    html: doc.snapshot.html,
    attachments: (doc.attachments ?? []).map((a) => ({ filename: a.filename, storedName: a.storedName })),
  };

  if (conteudoPorCampanha.size >= MAX_CAMPANHAS_EM_CACHE) conteudoPorCampanha.clear();
  conteudoPorCampanha.set(chave, conteudo);
  return conteudo;
}

async function processEmail(job: Job<EmailJob>, token?: string): Promise<void> {
  const { campaignId, sendLogId, to } = job.data;

  const campaign = await Campaign.findById(campaignId).select('status startedAt').lean();

  // A exclusão drena os jobs pendentes; aqui chegam os que já estavam ativos.
  if (!campaign) {
    logger.warn(`🗑  Envio descartado: campanha ${campaignId} não existe mais → ${to}`);
    return;
  }

  if (campaign.status === 'paused') {
    const pausedSince = job.data.pausedSince ?? Date.now();

    if (Date.now() - pausedSince >= MAX_PAUSE_WAIT_MS) {
      const hours = Math.round(MAX_PAUSE_WAIT_MS / 3_600_000);
      logger.warn(`⌛ Envio abandonado: campanha ${campaignId} pausada há mais de ${hours}h → ${to}`);
      await markFailed(campaignId, sendLogId, `Campanha permaneceu pausada por mais de ${hours}h.`);
      return;
    }

    if (job.data.pausedSince === undefined) await job.updateData({ ...job.data, pausedSince });
    await job.moveToDelayed(Date.now() + PAUSE_RECHECK_MS, token);
    throw new DelayedError();
  }

  // Limpa a marca para que uma pausa futura conte o tempo do zero.
  if (job.data.pausedSince !== undefined) {
    await job.updateData({ ...job.data, pausedSince: undefined });
  }

  // Reparte a capacidade do motor entre clientes, para um disparo grande não monopolizar a fila.
  const limits = (await Tenant.findById(job.data.tenantId).select('sendingLimits').lean())?.sendingLimits;

  const rate = await reserveTenantRate(job.data.tenantId, limits?.ratePerMinute);
  if (!rate.ok) {
    await job.moveToDelayed(Date.now() + rate.retryAfterMs, token);
    throw new DelayedError();
  }

  const slotId = String(job.id ?? `${campaignId}-${sendLogId}`);
  const gotSlot = await acquireTenantSlot(job.data.tenantId, limits?.concurrency, slotId);
  if (!gotSlot) {
    await job.moveToDelayed(Date.now() + SLOT_RECHECK_MS, token);
    throw new DelayedError();
  }

  try {
    await sendOne(job, token, String(campaign.startedAt?.getTime() ?? 0));
  } finally {
    await releaseTenantSlot(job.data.tenantId, limits?.concurrency, slotId);
  }
}

async function sendOne(job: Job<EmailJob>, token: string | undefined, versaoConteudo: string): Promise<void> {
  const { campaignId, sendLogId, smtpId, to, data } = job.data;

  // Jobs antigos ainda trazem o HTML no payload; os novos leem do snapshot da campanha.
  const conteudo = job.data.htmlTemplate
    ? {
        subject: job.data.subjectTemplate ?? '',
        html: job.data.htmlTemplate,
        attachments: job.data.attachments ?? [],
      }
    : await carregarConteudo(campaignId, versaoConteudo);

  if (!conteudo) {
    const motivo = 'Conteúdo da campanha não encontrado (campanha sem snapshot do disparo).';
    logger.error(`📄 ${motivo} → ${to}`);
    await markFailed(campaignId, sendLogId, motivo);
    return;
  }

  const smtp = smtpId === FALLBACK_SMTP_ID ? smtpService.getFallbackSmtp() : await SmtpSettings.findById(smtpId);

  // SMTP excluído após o disparo: retentar não resolve, então falha na hora.
  if (!smtp) {
    const motivo = `Servidor SMTP não encontrado (${smtpId}) — foi excluído depois do disparo?`;
    logger.error(`🔌 ${motivo} → ${to}`);
    await markFailed(campaignId, sendLogId, motivo);
    return;
  }

  // Cota estourada não é falha do envio: adia sem consumir tentativa.
  const quota = await reserveSmtpQuota(smtpId, smtp.dailyLimit, smtp.hourlyLimit);
  if (!quota.ok) {
    logger.info(
      `⏳ Cota ${quota.scope} do SMTP ${smtpId} atingida — envio adiado ${Math.round(quota.retryAfterMs / 1000)}s → ${to}`
    );
    await job.moveToDelayed(Date.now() + quota.retryAfterMs, token);
    throw new DelayedError();
  }

  try {
    const { messageId } = await emailService.send({
      smtp,
      to,
      subjectTemplate: conteudo.subject,
      htmlTemplate: conteudo.html,
      data,
      campaignId,
      sendLogId,
      attachments: conteudo.attachments,
    });

    // O email já saiu: relançar aqui faria o BullMQ retentar e enviar em duplicidade.
    try {
      await SendLog.updateOne(
        { _id: sendLogId },
        {
          status: 'sent',
          messageId,
          sentAt: new Date(),
          error: '',
        }
      );
      await Campaign.updateOne({ _id: campaignId }, { $inc: { 'stats.sent': 1 } });
      await Contact.updateOne({ email: to }, { lastDeliveredAt: new Date() });
      await finalizeIfDone(campaignId);
      logger.info(`✉️  Sent in campaign ${campaignId} → ${to}`);
    } catch (bookErr) {
      logSideEffect('emailWorker.postSend', bookErr, { campaignId, sendLogId, to });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    // Pausa a campanha e devolve este envio à fila sem gastá-lo; sai ao retomar.
    if (isAuthError(err)) {
      logger.error(`🔒 SMTP auth/config failure in campaign ${campaignId} → ${to}: ${detail}`);
      await pauseForSmtpAuth(campaignId, detail);
      await job.moveToDelayed(Date.now() + PAUSE_RECHECK_MS, token);
      throw new DelayedError();
    }

    if (isHardBounce(err)) {
      logger.warn(`✗ Bounce in campaign ${campaignId} → ${to}: ${detail}`);
      await bounceService.processBounce(to, campaignId, detail);
      await finalizeIfDone(campaignId);
      await autoPauseIfTooManyErrors(campaignId);
      return;
    }
    logger.warn(`↻ Transient error in campaign ${campaignId} → ${to} (attempt ${job.attemptsMade + 1}): ${detail}`);
    throw err;
  }
}

export async function stopEmailWorker(): Promise<void> {
  await closeSettingsBus();
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('🔴 Email worker closed');
  }
}

let worker: Worker<EmailJob> | null = null;
let reloading: Promise<void> | null = null;

function createWorker(settings: EngineSettings): Worker<EmailJob> {
  const created = new Worker<EmailJob>(
    EMAIL_QUEUE_NAME,
    (job, token) => {
      // Sem tenantId toda escrita filtraria por `undefined` e falharia em silêncio.
      if (!job.data.tenantId) {
        logger.warn(`🗑  Job ${job.id} descartado: sem tenantId (formato anterior ao multi-cliente).`);
        return Promise.resolve();
      }
      return runWithTenant(job.data.tenantId, () => processEmail(job, token));
    },
    {
      connection: redisConnection,
      concurrency: settings.workerConcurrency,
      limiter: { max: settings.ratePerMinute, duration: 60_000 },
    }
  );

  created.on('failed', async (job, err) => {
    if (!job) return;
    if (!job.data.tenantId) {
      logger.warn(`⚠️  Falha em job sem tenantId (${job.id}): ${err.message}`);
      return;
    }
    try {
      await runWithTenant(job.data.tenantId, async () => {
        if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
          logger.error(
            `✗ Permanent failure in campaign ${job.data.campaignId} → ${job.data.to} after ${job.attemptsMade} attempts: ${err.message}`
          );
          captureError(err, {
            scope: 'emailWorker.permanentFailure',
            campaignId: job.data.campaignId,
            to: job.data.to,
          });
          await markFailed(job.data.campaignId, job.data.sendLogId, err.message);
        } else {
          logSideEffect('emailWorker.retry', err, { jobId: job.id, attempt: job.attemptsMade });
        }
      });
    } catch (handlerErr) {
      logSideEffect('emailWorker.failedHandler', handlerErr, { jobId: job.id });
    }
  });

  return created;
}

export async function startEmailWorker(): Promise<Worker<EmailJob>> {
  const settings = await platformSettingsService.getEngineSettings();
  worker = createWorker(settings);

  await subscribeSettingsChanged(() => reloadEmailWorker());

  logger.info(`🟢 Email worker started (concorrência ${settings.workerConcurrency}, ${settings.ratePerMinute}/min)`);
  return worker;
}

/**
 * Recria o worker com os ajustes atuais: o `limiter` do BullMQ é fixado na construção.
 * O antigo fecha antes de o novo subir, senão as taxas se somariam durante a troca;
 * `close()` espera os envios ativos, então nenhum email se perde.
 */
export async function reloadEmailWorker(): Promise<void> {
  if (reloading) return reloading;

  reloading = (async () => {
    platformSettingsService.invalidate();
    const settings = await platformSettingsService.getEngineSettings();

    const previous = worker;
    worker = null;
    if (previous) await previous.close();

    worker = createWorker(settings);
    logger.info(`♻️  Email worker recriado (concorrência ${settings.workerConcurrency}, ${settings.ratePerMinute}/min)`);
  })();

  try {
    await reloading;
  } finally {
    reloading = null;
  }
}
