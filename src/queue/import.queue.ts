import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

export interface ImportJobData {
  /** Cliente dono da importação — o worker reabre o escopo com ele. */
  tenantId: string;
  importJobId: string;
  action: 'validate' | 'import';
}

export const IMPORT_QUEUE_NAME = 'contact-import';

/**
 * Fila separada da de emails de propósito: uma importação de 1 milhão de linhas
 * ocupa o worker por minutos, e compartilhar a fila faria o disparo de campanha
 * esperar atrás dela.
 */
export const importQueue = new Queue<ImportJobData>(IMPORT_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // Sem retentativa automática: reprocessar do zero um arquivo grande custa caro e
    // duplicaria o trabalho já feito. A falha fica registrada no ImportJob e o
    // usuário decide reenviar.
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export async function enqueueValidation(tenantId: string, importJobId: string): Promise<void> {
  await importQueue.add(
    'validate',
    { tenantId, importJobId, action: 'validate' },
    // jobId determinístico: um duplo-clique no botão não enfileira a mesma
    // validação duas vezes.
    { jobId: `validate-${importJobId}` }
  );
}

export async function enqueueImport(tenantId: string, importJobId: string): Promise<void> {
  await importQueue.add('import', { tenantId, importJobId, action: 'import' }, { jobId: `import-${importJobId}` });
}
