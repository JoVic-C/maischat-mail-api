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

/**
 * Consulta do progresso de uma importação (GET de `/import/open` e `/import/:id`).
 *
 * A tela pergunta de tempos em tempos enquanto o worker trabalha, então uma única
 * importação longa consumia a cota geral inteira sozinha: com 200 requisições por 15
 * minutos, bastavam 4 minutos de acompanhamento para a pessoa levar 429 no meio do
 * trabalho — e o pior é que o servidor terminava a importação normalmente, só a tela
 * é que ficava sem saber.
 */
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
  // Fora da cota geral, mas não sem limite: tem o seu, logo abaixo.
  skip: ehConsultaDeProgresso,
});

/**
 * Teto próprio do acompanhamento. Generoso porque é leitura barata e previsível — e
 * ainda assim um teto, para uma aba esquecida aberta não virar tráfego infinito.
 */
export const importProgressLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_IMPORT_PROGRESS_MAX) || 1500,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:import:'),
  message: { error: 'Muitas consultas de progresso. Aguarde alguns instantes.' },
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
