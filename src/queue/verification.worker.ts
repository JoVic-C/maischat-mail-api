import { type Job, Worker } from 'bullmq';
import { redisConnection } from '../config/redis';
import { captureError } from '../config/sentry';
import { runWithTenant } from '../config/tenantContext';
import emailVerificationService from '../services/emailVerification.service';
import { logger, logSideEffect } from '../utils/logger';
import { VERIFICATION_QUEUE_NAME, type VerificationQueueData } from './verification.queue';

let worker: Worker<VerificationQueueData> | null = null;

/** Cada etapa é curta (uma chamada ao provedor ou um lote de gravações); não precisa de mais. */
const CONCURRENCY = Number(process.env.EMAIL_VERIFY_WORKER_CONCURRENCY || 2);

async function handleJob(job: Job<VerificationQueueData>): Promise<void> {
  const { tenantId, verificationJobId, step, attempt } = job.data;
  if (!tenantId || !verificationJobId) {
    logger.warn(`🗑  Job de verificação ${job.id} descartado: sem tenantId ou verificationJobId.`);
    return;
  }
  await runWithTenant(tenantId, () => emailVerificationService.runStep(verificationJobId, step, attempt ?? 0));
}

export function startVerificationWorker(): Worker<VerificationQueueData> {
  worker = new Worker<VerificationQueueData>(VERIFICATION_QUEUE_NAME, handleJob, {
    connection: redisConnection,
    concurrency: CONCURRENCY,
  });

  worker.on('failed', async (job, err) => {
    logSideEffect('verificationWorker.failed', err, { verificationJobId: job?.data.verificationJobId });
    captureError(err, { scope: 'verificationWorker.failed', verificationJobId: job?.data.verificationJobId });
    // A tela lê o motivo no VerificationJob; sem isto ficaria "verificando" para sempre.
    if (!job?.data.tenantId || !job.data.verificationJobId) return;
    try {
      await runWithTenant(job.data.tenantId, () =>
        emailVerificationService.markFailed(job.data.verificationJobId, 'Falha ao processar a verificação.')
      );
    } catch (markErr) {
      logSideEffect('verificationWorker.markFailed', markErr, { verificationJobId: job.data.verificationJobId });
    }
  });

  logger.info(`🟢 Email verification worker started (concurrency ${CONCURRENCY})`);
  return worker;
}

export async function stopVerificationWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
  logger.info('🔴 Email verification worker closed');
}
