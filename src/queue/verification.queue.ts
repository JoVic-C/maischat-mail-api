import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

export type VerificationStep = 'upload' | 'poll' | 'apply';

export interface VerificationQueueData {
  tenantId: string;
  verificationJobId: string;
  step: VerificationStep;
  /** Tentativas após falha passageira do provedor (limite de requisições, fora do ar). */
  attempt: number;
}

export const VERIFICATION_QUEUE_NAME = 'email-verification';

/**
 * A lista fica horas no provedor: em vez de segurar um worker esperando, cada consulta de
 * progresso é um job atrasado.
 */
export const verificationQueue = new Queue<VerificationQueueData>(VERIFICATION_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // Reenviar a lista cobraria os créditos de novo; a retentativa é controlada à mão.
    attempts: 1,
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

export async function enqueueVerificationStep(
  tenantId: string,
  verificationJobId: string,
  step: VerificationStep,
  opts: { delayMs?: number; attempt?: number } = {}
): Promise<void> {
  const attempt = opts.attempt ?? 0;
  await verificationQueue.add(
    step,
    { tenantId, verificationJobId, step, attempt },
    {
      delay: opts.delayMs ?? 0,
      // O envio é determinístico: um duplo clique não manda a lista duas vezes ao provedor.
      jobId: step === 'upload' ? `verify-upload-${verificationJobId}-${attempt}` : undefined,
    }
  );
}
