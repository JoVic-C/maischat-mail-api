import { type Job, Worker } from 'bullmq';
import { redisConnection } from '../config/redis';
import { captureError } from '../config/sentry';
import { runWithTenant } from '../config/tenantContext';
import campaignService from '../services/campaign.service';
import { logger, logSideEffect } from '../utils/logger';
import { SCHEDULER_QUEUE_NAME, type ScheduleJob } from './scheduler.queue';

let worker: Worker<ScheduleJob> | null = null;

export function startSchedulerWorker(): Worker<ScheduleJob> {
  worker = new Worker<ScheduleJob>(
    SCHEDULER_QUEUE_NAME,
    async (job: Job<ScheduleJob>) => {
      logger.info(`⏰ Scheduled dispatch time — campaign ${job.data.campaignId}`);
      // Sem requisição: o escopo do cliente é reaberto a partir do próprio job.
      await runWithTenant(job.data.tenantId, () => campaignService.start(job.data.campaignId));
    },
    { connection: redisConnection }
  );

  worker.on('failed', (job, err) => {
    logSideEffect('schedulerWorker.failed', err, { campaignId: job?.data.campaignId });
    captureError(err, { scope: 'schedulerWorker.failed', campaignId: job?.data.campaignId });
  });

  logger.info('🟢 Scheduler worker started');
  return worker;
}

export async function stopSchedulerWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    logger.info('🔴 Scheduler worker closed');
  }
}
