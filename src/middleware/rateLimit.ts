import rateLimit, { type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisConnection } from '../config/redis';
import { logger } from '../utils/logger';

const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const max = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 200;

/** No Redis, a contagem é compartilhada entre instâncias da API. */
function redisStore(prefix: string): Store {
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redisConnection.call(...(args as [string, ...string[]])) as Promise<never>,
  });
}

/** A tela consulta o progresso da importação em intervalos; isso esgotaria a cota geral. */
const CONSULTA_DE_PROGRESSO = /^\/api\/contacts\/import\/[^/]+$/;

export function ehConsultaDeProgresso(req: { method: string; path: string }): boolean {
  return req.method === 'GET' && CONSULTA_DE_PROGRESSO.test(req.path);
}

export const generalLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:general:'),
  message: { error: 'Muitas requisições. Tente novamente em instantes.' },
  skip: ehConsultaDeProgresso,
});

export const importProgressLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_IMPORT_PROGRESS_MAX) || 1500,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:import:'),
  message: { error: 'Muitas consultas de progresso. Aguarde alguns instantes.' },
});

/** Só conta as tentativas que falham. */
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
