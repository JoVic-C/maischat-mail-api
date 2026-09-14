import { type JobType, Queue } from 'bullmq';
import { redisConnection } from '../config/redis';
import { logSideEffect } from '../utils/logger';

export interface EmailJob {
  tenantId: string;
  campaignId: string;
  sendLogId: string;
  smtpId: string;
  to: string;
  data: Record<string, string>;

  /**
   * Legado: o conteúdo agora vem do `snapshot` da campanha. Mantido para os jobs que já
   * estavam na fila; pode sair quando a fila girar por completo.
   */
  subjectTemplate?: string;
  htmlTemplate?: string;
  attachments?: { filename: string; storedName: string }[];
  /** Quando o job encontrou a campanha pausada pela primeira vez. */
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

const PENDING_STATES: JobType[] = ['waiting', 'delayed', 'prioritized', 'paused'];

/**
 * Remove os envios pendentes de uma campanha excluída. Jobs já ativos não são removíveis;
 * o worker os descarta ao não encontrar a campanha.
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
      // O job saiu do estado pendente entre a leitura e a remoção.
      logSideEffect('emailQueue.removeCampaignJobs', err, { jobId: job.id });
    }
  }
  return removed;
}
