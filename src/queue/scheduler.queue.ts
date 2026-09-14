import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

export const SCHEDULER_QUEUE_NAME = 'campaign-scheduler';

export interface ScheduleJob {
  tenantId: string;
  campaignId: string;
}

export const schedulerQueue = new Queue<ScheduleJob>(SCHEDULER_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100 },
});

export async function scheduleCampaign(tenantId: string, campaignId: string, delayMs: number): Promise<void> {
  await schedulerQueue.add('start', { tenantId, campaignId }, { delay: delayMs, jobId: `schedule-${campaignId}` });
}

export async function cancelSchedule(campaignId: string): Promise<void> {
  const job = await schedulerQueue.getJob(`schedule-${campaignId}`);
  if (job) await job.remove();
}
