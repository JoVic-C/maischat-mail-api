import { Redis } from 'ioredis';
import { logger } from '../utils/logger';

export const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // exigido pelo BullMQ
  retryStrategy: (times) => Math.min(times * 200, 5000), // backoff até 5s entre reconexões (não martela)
  // Conecta no primeiro uso, não no import. Assim quem só importa um módulo que
  // (indiretamente) puxa este arquivo — um teste, o script de rotação, um CLI —
  // não abre socket nem segura o event loop aberto.
  lazyConnect: true,
});

/**
 * Cria uma conexão nova com as mesmas opções da principal.
 *
 * Existe porque um cliente em modo `subscribe` não aceita nenhum outro comando —
 * quem escuta um canal precisa de socket próprio, separado do que a fila usa.
 */
export function createRedisClient(): Redis {
  return new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: true,
  });
}

/** Abre a conexão explicitamente (chamado no boot da API). Idempotente. */
export async function connectRedis(): Promise<void> {
  if (redisConnection.status === 'end' || redisConnection.status === 'wait') {
    await redisConnection.connect();
  }
}

/** Fecha a conexão se ela chegou a ser aberta. */
export async function disconnectRedis(): Promise<void> {
  if (redisConnection.status === 'wait' || redisConnection.status === 'end') return;
  await redisConnection.quit();
}

redisConnection.on('connect', () => logger.info('🟢 Redis connected'));

// Quando o Redis está fora, o ioredis dispara 'error' a cada tentativa — loga no máx. 1x a cada 15s
// para não inundar o log (o backoff acima já reduz a frequência das tentativas).
let lastRedisErrorLog = 0;
redisConnection.on('error', (err) => {
  const now = Date.now();
  if (now - lastRedisErrorLog > 15000) {
    lastRedisErrorLog = now;
    logger.error('Redis connection error', { message: err.message });
  }
});
