import { type Job, Worker } from 'bullmq';
import { redisConnection } from '../config/redis';
import { captureError } from '../config/sentry';
import { runAsSystem, runWithTenant } from '../config/tenantContext';
import contactImportService, { ensureImportDir } from '../services/contactImport.service';
import { logger, logSideEffect } from '../utils/logger';
import { IMPORT_QUEUE_NAME, type ImportJobData, importQueue } from './import.queue';

let worker: Worker<ImportJobData> | null = null;

const CLEANUP_JOB = 'cleanup-expired';

/**
 * Baixa de propósito: jobs em paralelo dividiriam a mesma banda de banco e disco e
 * multiplicariam o pico de memória do conjunto de emails já vistos.
 */
const CONCURRENCY = Number(process.env.IMPORT_WORKER_CONCURRENCY || 2);

async function handleJob(job: Job<ImportJobData>): Promise<void> {
  if (job.name === CLEANUP_JOB) {
    await runAsSystem(() => contactImportService.cleanupExpired());
    return;
  }

  const { tenantId, importJobId, action } = job.data;
  if (!tenantId || !importJobId) {
    logger.warn(`🗑  Job de importação ${job.id} descartado: sem tenantId ou importJobId.`);
    return;
  }

  await runWithTenant(tenantId, async () => {
    if (action === 'validate') await contactImportService.runValidation(importJobId);
    else await contactImportService.runImport(importJobId);
  });
}

export async function startImportWorker(): Promise<Worker<ImportJobData>> {
  ensureImportDir();

  worker = new Worker<ImportJobData>(IMPORT_QUEUE_NAME, handleJob, {
    connection: redisConnection,
    concurrency: CONCURRENCY,
  });

  worker.on('failed', async (job, err) => {
    if (!job || job.name === CLEANUP_JOB) {
      logSideEffect('importWorker.failed', err, { jobId: job?.id });
      return;
    }
    logSideEffect('importWorker.failed', err, { importJobId: job.data.importJobId, action: job.data.action });
    captureError(err, { scope: 'importWorker.failed', importJobId: job.data.importJobId });

    // A tela lê o motivo no ImportJob; sem isto ficaria "validando" para sempre.
    if (!job.data.tenantId || !job.data.importJobId) return;
    try {
      await runWithTenant(job.data.tenantId, () =>
        contactImportService.markFailed(job.data.importJobId, err.message || 'Falha ao processar a importação.')
      );
    } catch (markErr) {
      logSideEffect('importWorker.markFailed', markErr, { importJobId: job.data.importJobId });
    }
  });

  // `jobId` fixo com repeat mantém uma única agenda entre reinícios e réplicas.
  await importQueue.add(
    CLEANUP_JOB,
    { tenantId: '', importJobId: '', action: 'validate' },
    { repeat: { pattern: '0 * * * *' }, jobId: CLEANUP_JOB, removeOnComplete: 10, removeOnFail: 10 }
  );

  logger.info(`🟢 Import worker started (concurrency ${CONCURRENCY})`);
  return worker;
}

export async function stopImportWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
  logger.info('🔴 Import worker closed');
}
