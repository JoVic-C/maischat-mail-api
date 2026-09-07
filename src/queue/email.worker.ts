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
 * Marca a campanha como 'completed' quando TODOS os envios terminaram (sent + failed >= total).
 * Atômico e à prova de corrida: o $expr compara os campos no próprio banco e a condição
 * status:'sending' garante que só UM worker (o último a terminar) faça a transição.
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

/** Erro de SMTP com código permanente 5xx = hard bounce (não adianta retentar). */
function isHardBounce(err: unknown): boolean {
  const code = (err as { responseCode?: number })?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

/**
 * Falha de autenticação/config do SMTP (ex.: 535 Invalid login). É problema do REMETENTE,
 * não do destinatário — NÃO pode marcar o contato como bounce.
 */
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

/** Limite de erros (falhas + bounces) antes de auto-pausar a campanha (estilo Listmonk). */
const MAX_ERRORS = Number(process.env.CAMPAIGN_MAX_ERRORS) || 100;

async function autoPauseIfTooManyErrors(campaignId: string): Promise<void> {
  const res = await Campaign.updateOne(
    {
      _id: campaignId,
      status: 'sending',
      $expr: { $gte: [{ $add: ['$stats.failed', '$stats.bounced'] }, MAX_ERRORS] },
    },
    { status: 'paused' }
  );
  if (res.modifiedCount > 0) {
    logger.warn(`⏸  Campaign ${campaignId} AUTO-PAUSED: errors exceeded ${MAX_ERRORS} (SMTP issue?)`);
  }
}

/** Quanto tempo adiar um job cuja campanha está pausada, antes de checar de novo.
 *  Também é a latência máxima do "retomar" (o job adiado espera este intervalo). */
const PAUSE_RECHECK_MS = 4000;

/** Espera antes de tentar de novo quando o cliente está com todos os slots ocupados. */
const SLOT_RECHECK_MS = 2000;

/** Teto de espera de um job numa campanha pausada. Sem ele, uma campanha auto-pausada e
 *  nunca retomada mantém milhares de jobs reciclando no Redis indefinidamente. */
const MAX_PAUSE_WAIT_MS = Number(process.env.CAMPAIGN_MAX_PAUSE_WAIT_MS) || 24 * 60 * 60 * 1000;

/** Falha definitiva de um envio (sem retry): marca o log e atualiza as métricas da campanha. */
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
 * Conteúdo já carregado, por campanha.
 *
 * O worker consulta a campanha a cada job de qualquer forma (para checar pausa e
 * exclusão), mas o HTML não pode ser relido milhões de vezes. A chave inclui o
 * `startedAt`: reiniciar a campanha gera um snapshot novo e invalida o cache sozinho,
 * sem depender de prazo.
 */
const conteudoPorCampanha = new Map<string, ConteudoCampanha>();

/** Poucas campanhas enviam ao mesmo tempo; um teto simples evita crescer sem limite. */
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

/** Processa 1 job = envia 1 email e atualiza o SendLog + stats da campanha. */
async function processEmail(job: Job<EmailJob>, token?: string): Promise<void> {
  const { campaignId, sendLogId, to } = job.data;

  const campaign = await Campaign.findById(campaignId).select('status startedAt').lean();

  // Campanha excluída enquanto o job esperava na fila: descarta SEM enviar.
  // (a exclusão já drena os pendentes; aqui pegamos os que estavam 'active' na hora).
  if (!campaign) {
    logger.warn(`🗑  Envio descartado: campanha ${campaignId} não existe mais → ${to}`);
    return;
  }

  // Campanha pausada? Adia o job (sem enviar) e checa de novo em PAUSE_RECHECK_MS. Não conta como falha.
  if (campaign.status === 'paused') {
    const pausedSince = job.data.pausedSince ?? Date.now();

    // Teto de espera: pausa que nunca é retomada encerra o envio em vez de reciclar para sempre.
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

  // Campanha retomada: limpa a marca para que uma pausa futura conte o tempo do zero.
  if (job.data.pausedSince !== undefined) {
    await job.updateData({ ...job.data, pausedSince: undefined });
  }

  // ── Fatia de capacidade deste cliente (definida pelo superadmin) ──
  // Não é capacidade extra: reparte a piscina do motor entre os clientes, para um
  // disparo grande não monopolizar a fila dos demais.
  const limits = (await Tenant.findById(job.data.tenantId).select('sendingLimits').lean())?.sendingLimits;

  const rate = await reserveTenantRate(job.data.tenantId, limits?.ratePerMinute);
  if (!rate.ok) {
    await job.moveToDelayed(Date.now() + rate.retryAfterMs, token);
    throw new DelayedError();
  }

  const slotId = String(job.id ?? `${campaignId}-${sendLogId}`);
  const gotSlot = await acquireTenantSlot(job.data.tenantId, limits?.concurrency, slotId);
  if (!gotSlot) {
    // Cliente no teto de simultâneos: volta para a fila sem consumir tentativa.
    await job.moveToDelayed(Date.now() + SLOT_RECHECK_MS, token);
    throw new DelayedError();
  }

  try {
    await sendOne(job, token, String(campaign.startedAt?.getTime() ?? 0));
  } finally {
    // O slot precisa voltar em QUALQUER saída, inclusive erro — senão o cliente trava.
    await releaseTenantSlot(job.data.tenantId, limits?.concurrency, slotId);
  }
}

/** Envio propriamente dito, já dentro do slot do cliente. */
async function sendOne(job: Job<EmailJob>, token: string | undefined, versaoConteudo: string): Promise<void> {
  const { campaignId, sendLogId, smtpId, to, data } = job.data;

  // Conteúdo: o job novo não o carrega — vem do snapshot da campanha. Jobs ANTIGOS,
  // enfileirados antes desta mudança, ainda trazem o HTML dentro deles; usar o que
  // vier no job evita perder o que já estava na fila no momento do deploy.
  const conteudo = job.data.htmlTemplate
    ? {
        subject: job.data.subjectTemplate ?? '',
        html: job.data.htmlTemplate,
        attachments: job.data.attachments ?? [],
      }
    : await carregarConteudo(campaignId, versaoConteudo);

  if (!conteudo) {
    // Sem conteúdo não há o que enviar, e retentar não o faz aparecer. Falha permanente.
    const motivo = 'Conteúdo da campanha não encontrado (campanha sem snapshot do disparo).';
    logger.error(`📄 ${motivo} → ${to}`);
    await markFailed(campaignId, sendLogId, motivo);
    return;
  }

  // xMailer embutido (id sentinela) ou SMTP do cliente pelo id.
  const smtp = smtpId === FALLBACK_SMTP_ID ? smtpService.getFallbackSmtp() : await SmtpSettings.findById(smtpId);

  // SMTP apagado depois que a campanha foi enfileirada. É erro PERMANENTE de
  // configuração: retentar não faz o servidor voltar a existir. Marca a falha na hora,
  // em vez de gastar as 3 tentativas e só então registrar.
  if (!smtp) {
    const motivo = `Servidor SMTP não encontrado (${smtpId}) — foi excluído depois do disparo?`;
    logger.error(`🔌 ${motivo} → ${to}`);
    await markFailed(campaignId, sendLogId, motivo);
    return;
  }

  // Cota do servidor SMTP (dailyLimit/hourlyLimit). Estourou? Adia até a janela virar —
  // não é falha do envio, então não conta como erro nem consome tentativa.
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

    // Pós-envio: o email JÁ saiu. Uma falha nas escritas abaixo NÃO pode relançar,
    // senão o BullMQ retentaria e REENVIARIA o email (duplicado). Isolamos num try próprio.
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
      await Contact.updateOne({ email: to }, { lastDeliveredAt: new Date() }); // marca "recebeu" no contato
      await finalizeIfDone(campaignId);
      logger.info(`✉️  Sent in campaign ${campaignId} → ${to}`);
    } catch (bookErr) {
      logSideEffect('emailWorker.postSend', bookErr, { campaignId, sendLogId, to });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    // Falha de autenticação/config do SMTP: problema do remetente, não do destinatário.
    // Marca o envio como 'failed' (SEM bouncar o contato) e deixa o auto-pause agir.
    if (isAuthError(err)) {
      logger.error(`🔒 SMTP auth/config failure in campaign ${campaignId} → ${to}: ${detail}`);
      await markFailed(campaignId, sendLogId, detail);
      return;
    }

    // Hard bounce (5xx): permanente — marca bounce e NÃO relança (sem retry).
    if (isHardBounce(err)) {
      logger.warn(`✗ Bounce in campaign ${campaignId} → ${to}: ${detail}`);
      await bounceService.processBounce(to, campaignId, detail); // guarda o erro SMTP real
      await finalizeIfDone(campaignId);
      await autoPauseIfTooManyErrors(campaignId);
      return;
    }
    logger.warn(`↻ Transient error in campaign ${campaignId} → ${to} (attempt ${job.attemptsMade + 1}): ${detail}`);
    throw err; // erro transitório (4xx/rede): relança para o BullMQ retentar
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
/** Recarga em andamento — evita que dois avisos simultâneos recriem o worker duas vezes. */
let reloading: Promise<void> | null = null;

function createWorker(settings: EngineSettings): Worker<EmailJob> {
  const created = new Worker<EmailJob>(
    EMAIL_QUEUE_NAME,
    // Todo o processamento roda DENTRO do escopo do cliente dono da campanha —
    // o worker não tem requisição, então o contexto é reaberto a partir do job.
    (job, token) => {
      // Job sem cliente não pode ser processado: abrir escopo com tenantId indefinido
      // faria toda escrita filtrar por `tenantId: undefined` e falhar em silêncio.
      // Acontece com jobs enfileirados antes do multi-cliente, que ficam parados na fila.
      if (!job.data.tenantId) {
        logger.warn(`🗑  Job ${job.id} descartado: sem tenantId (formato anterior ao multi-cliente).`);
        return Promise.resolve();
      }
      return runWithTenant(job.data.tenantId, () => processEmail(job, token));
    },
    {
      connection: redisConnection,
      // Ambos vêm da tela do superadmin (models/PlatformSettings), não mais do código.
      concurrency: settings.workerConcurrency,
      // Janela de 1 minuto: é a unidade que o superadmin configura e a que os provedores
      // publicam. O pico dentro da janela é contido pela concorrência acima.
      limiter: { max: settings.ratePerMinute, duration: 60_000 },
    }
  );

  created.on('failed', async (job, err) => {
    if (!job) return;
    // Sem cliente não há como escopar a escrita — só registra e sai, em vez de
    // gravar em lugar nenhum e o painel mostrar falha na fila que nunca vira falha no log.
    if (!job.data.tenantId) {
      logger.warn(`⚠️  Falha em job sem tenantId (${job.id}): ${err.message}`);
      return;
    }
    try {
      // Também precisa de escopo: aqui há escrita em SendLog/Campaign.
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

  // Mudança feita em QUALQUER instância chega aqui e recria este worker.
  await subscribeSettingsChanged(() => reloadEmailWorker());

  logger.info(`🟢 Email worker started (concorrência ${settings.workerConcurrency}, ${settings.ratePerMinute}/min)`);
  return worker;
}

/**
 * Recria o worker com os ajustes atuais.
 *
 * O `limiter` do BullMQ é fixado na construção — não há como mudar a taxa em um worker
 * vivo. O worker antigo é fechado ANTES de o novo subir: com os dois no ar, as taxas se
 * somariam e o teto configurado seria furado justamente no momento da mudança.
 * `close()` sem força espera os envios ativos terminarem, então nenhum email se perde;
 * o custo é uma pausa curta em que a fila não avança.
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
