import 'dotenv/config';
import { initSentry } from './config/sentry';

initSentry(); // antes de tudo: o SDK instrumenta http/express/mongo no carregamento

// Importado DEPOIS do initSentry de propósito: o TypeScript preserva a ordem das
// declarações, e o SDK precisa instrumentar express/mongo antes de eles carregarem.
import app from './app';
import connectDB, { disconnectDB } from './config/db';
import { connectRedis, disconnectRedis } from './config/redis';
import { startEmailWorker, stopEmailWorker } from './queue/email.worker';
import { startImportWorker, stopImportWorker } from './queue/import.worker';
import { startSchedulerWorker, stopSchedulerWorker } from './queue/scheduler.worker';
import { logger } from './utils/logger';

// Falha cedo se faltar config crítica de segurança (evita subir num estado inseguro).
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
  // Assíncrono: o worker lê concorrência e taxa dos ajustes da plataforma antes de subir.
  await startEmailWorker();
  // Validação e gravação de CSV grande: fila própria, para não disputar com o envio.
  await startImportWorker();
  startSchedulerWorker();
});
