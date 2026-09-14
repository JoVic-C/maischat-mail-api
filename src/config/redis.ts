import { Redis } from 'ioredis';
import { logger } from '../utils/logger';

export const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // exigido pelo BullMQ
  retryStrategy: (times) => Math.min(times * 200, 5000),
  // Conecta no primeiro uso: testes, scripts e CLIs que só importam o módulo não seguram o event loop.
  lazyConnect: true,
});

/** Conexão separada: um cliente em modo `subscribe` não aceita outros comandos. */
export function createRedisClient(): Redis {
  return new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: true,
  });
}

export async function connectRedis(): Promise<void> {
  if (redisConnection.status === 'end' || redisConnection.status === 'wait') {
    await redisConnection.connect();
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redisConnection.status === 'wait' || redisConnection.status === 'end') return;
  await redisConnection.quit();
}

redisConnection.on('connect', () => logger.info('🟢 Redis connected'));

// Com o Redis fora, o ioredis emite erro a cada tentativa: loga no máximo uma vez a cada 15s.
let lastRedisErrorLog = 0;
redisConnection.on('error', (err) => {
  const now = Date.now();
  if (now - lastRedisErrorLog > 15000) {
    lastRedisErrorLog = now;
    logger.error('Redis connection error', { message: err.message });
  }
});
