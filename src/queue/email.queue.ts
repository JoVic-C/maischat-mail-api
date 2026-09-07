import { type JobType, Queue } from 'bullmq';
import { redisConnection } from '../config/redis';
import { logSideEffect } from '../utils/logger';

export interface EmailJob {
  /** Cliente dono da campanha — o worker reabre o escopo com ele. */
  tenantId: string;
  campaignId: string;
  sendLogId: string;
  smtpId: string;
  to: string;
  data: Record<string, string>;

  /**
   * Conteúdo do email — LEGADO, e por isso opcional.
   *
   * O HTML já viajou dentro de cada job. Numa campanha de milhões de destinatários
   * isso duplicava o mesmo email milhões de vezes no Redis (dezenas de GB), e o
   * enfileiramento morria antes de terminar. Hoje o conteúdo vive em UMA cópia, no
   * `snapshot` da campanha, e o worker o lê de lá.
   *
   * Estes campos continuam aqui para os jobs que já estavam na fila quando a mudança
   * subiu: o worker usa o que vier no job e só busca o snapshot quando não vier. Podem
   * ser removidos depois que a fila girar por completo.
   */
  subjectTemplate?: string;
  htmlTemplate?: string;
  attachments?: { filename: string; storedName: string }[];
  /** Momento (ms) em que o job encontrou a campanha pausada pela 1ª vez — teto de espera no worker. */
  pausedSince?: number;
}

export const EMAIL_QUEUE_NAME = 'email-sending';

export const emailQueue = new Queue<EmailJob>(EMAIL_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export async function enqueueEmails(jobs: EmailJob[]): Promise<void> {
  await emailQueue.addBulk(
    jobs.map((data) => ({
      name: 'send',
      data,
      opts: { jobId: `${data.campaignId}-${data.sendLogId}` },
    }))
  );
}

/** Estados em que um job ainda NÃO começou a ser processado (removível com segurança). */
const PENDING_STATES: JobType[] = ['waiting', 'delayed', 'prioritized', 'paused'];

/**
 * Remove da fila os envios ainda pendentes de uma campanha.
 * Chamado ao excluir a campanha: sem isso, os jobs sobrevivem no Redis e o worker
 * continuaria enviando emails de uma campanha que não existe mais.
 * Jobs já em processamento (`active`) não são removíveis — o worker os descarta ao
 * não encontrar a campanha.
 */
export async function removeCampaignJobs(campaignId: string): Promise<number> {
  const jobs = await emailQueue.getJobs(PENDING_STATES);
  let removed = 0;
  for (const job of jobs) {
    if (job.data?.campaignId !== campaignId) continue;
    try {
      await job.remove();
      removed++;
    } catch (err) {
      // Job saiu do estado pendente entre o getJobs e o remove — não aborta o lote.
      logSideEffect('emailQueue.removeCampaignJobs', err, { jobId: job.id });
    }
  }
  return removed;
}
