import { DelayedError, type Job, Worker } from 'bullmq';
import { redisConnection } from '../config/redis';
import { captureError } from '../config/sentry';
import { runWithTenant } from '../config/tenantContext';
import formWebhookService from '../services/formWebhook.service';
import { logger, logSideEffect } from '../utils/logger';
import { FORM_EMAIL_QUEUE_NAME, type FormEmailJob } from './formEmail.queue';

let worker: Worker<FormEmailJob> | null = null;

const CONCURRENCY = Number(process.env.FORM_EMAIL_WORKER_CONCURRENCY) || 5;

/** Recusa definitiva do servidor (5xx): tentar de novo não muda o resultado. */
function isPermanentSmtpError(err: unknown): boolean {
  const code = (err as { responseCode?: unknown })?.responseCode;
  return typeof code === 'number' && code >= 500;
}

export async function processFormEmail(job: Job<FormEmailJob>, token?: string): Promise<void> {
  const { tenantId, submissionId } = job.data;
  await runWithTenant(tenantId, async () => {
    try {
      const outcome = await formWebhookService.deliver(submissionId);
      if (outcome.kind === 'retry-after') {
        await job.moveToDelayed(Date.now() + outcome.ms, token);
        throw new DelayedError();
      }
    } catch (err) {
      if (err instanceof DelayedError) throw err;
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (!isPermanentSmtpError(err) && !lastAttempt) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      await formWebhookService.markFailed(submissionId, `Falha no envio: ${detail}`);
    }
  });
}

export function startFormEmailWorker(): Worker<FormEmailJob> {
  worker = new Worker<FormEmailJob>(FORM_EMAIL_QUEUE_NAME, processFormEmail, {
    connection: redisConnection,
    concurrency: CONCURRENCY,
  });

  worker.on('failed', (job, err) => {
    logSideEffect('formEmailWorker.failed', err, { submissionId: job?.data.submissionId });
    captureError(err, { scope: 'formEmailWorker.failed', submissionId: job?.data.submissionId });
  });

  logger.info(`🟢 Form email worker started (concurrency ${CONCURRENCY})`);
  return worker;
}

export async function stopFormEmailWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
  logger.info('🔴 Form email worker closed');
}
