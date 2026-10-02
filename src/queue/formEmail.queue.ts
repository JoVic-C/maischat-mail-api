import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

export interface FormEmailJob {
  tenantId: string;
  submissionId: string;
}

export const FORM_EMAIL_QUEUE_NAME = 'form-email';

/** Separada da fila de campanhas: uma campanha grande não pode atrasar a resposta a um formulário. */
export const formEmailQueue = new Queue<FormEmailJob>(FORM_EMAIL_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});

export async function enqueueFormEmail(job: FormEmailJob): Promise<void> {
  await formEmailQueue.add('send', job, { jobId: `form-${job.submissionId}` });
}
