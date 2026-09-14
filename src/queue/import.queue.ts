import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

export interface ImportJobData {
  tenantId: string;
  importJobId: string;
  action: 'validate' | 'import';
}

export const IMPORT_QUEUE_NAME = 'contact-import';

/** Separada da fila de emails: uma importação grande não pode atrasar disparos. */
export const importQueue = new Queue<ImportJobData>(IMPORT_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // Sem retentativa: reprocessar um arquivo grande do zero é caro; o usuário decide reenviar.
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export async function enqueueValidation(tenantId: string, importJobId: string): Promise<void> {
  await importQueue.add(
    'validate',
    { tenantId, importJobId, action: 'validate' },
    // Determinístico: um duplo clique não enfileira a mesma validação duas vezes.
    { jobId: `validate-${importJobId}` }
  );
}

export async function enqueueImport(tenantId: string, importJobId: string): Promise<void> {
  await importQueue.add('import', { tenantId, importJobId, action: 'import' }, { jobId: `import-${importJobId}` });
}
