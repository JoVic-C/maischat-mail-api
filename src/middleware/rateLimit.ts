import rateLimit, { type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisConnection } from '../config/redis';
import { logger } from '../utils/logger';

const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const max = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 200;

/**
 * O store padrão do express-rate-limit é em memória: com N instâncias da API cada uma
 * conta separado e o limite efetivo vira N×max. O Redis (já obrigatório para a fila)
 * centraliza a contagem. Se o Redis cair, o ioredis enfileira os comandos e o limiter
 * volta a responder quando ele reconecta.
 */
function redisStore(prefix: string): Store {
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redisConnection.call(...(args as [string, ...string[]])) as Promise<never>,
  });
}

export const generalLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:general:'),
  message: { error: 'Muitas requisições. Tente novamente em instantes.' },
});

/** Limiter estrito para login — freia brute-force/credential-stuffing. Só conta tentativas que falham. */
export const authLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: redisStore('rl:auth:'),
  message: { error: 'Muitas tentativas de login. Tente novamente em instantes.' },
});

logger.info(`🛡️  Rate limit: ${max} req / ${Math.round(windowMs / 60000)}min (store: Redis)`);
