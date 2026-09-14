import 'dotenv/config';
import { initSentry } from './config/sentry';

// Antes dos demais imports: o SDK instrumenta express e mongo no carregamento.
initSentry();

import app from './app';
import connectDB, { disconnectDB } from './config/db';
import { connectRedis, disconnectRedis } from './config/redis';
import { startEmailWorker, stopEmailWorker } from './queue/email.worker';
import { startImportWorker, stopImportWorker } from './queue/import.worker';
import { startSchedulerWorker, stopSchedulerWorker } from './queue/scheduler.worker';
import { logger } from './utils/logger';

for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY', 'MONGO_URI']) {
  if (!process.env[key]) {
    logger.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

connectDB();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`🛑 ${signal} received — shutting down gracefully...`);

  const forceTimer = setTimeout(() => {
    logger.error('⚠️  Forced shutdown (timeout)');
    process.exit(1);
  }, 15000);
  forceTimer.unref();

  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopEmailWorker();
    await stopImportWorker();
    await stopSchedulerWorker();
    await disconnectRedis();
    await disconnectDB();
    clearTimeout(forceTimer);
    logger.info('👋 Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { message: (err as Error).message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, async () => {
  await connectRedis();
  logger.info(`🟢 mMail API listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  await startEmailWorker();
  await startImportWorker();
  startSchedulerWorker();
});
