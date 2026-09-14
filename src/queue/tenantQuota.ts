import { redisConnection } from '../config/redis';

/**
 * Fatia de capacidade de cada cliente no motor de envio. Reparte os slots do worker entre
 * os clientes, sem criar capacidade nova, e fica no Redis para valer entre instâncias.
 *
 * - taxa por minuto: contador de janela fixa
 * - envios simultâneos: semáforo, que precisa ser devolvido ao fim do envio
 */

const MINUTE_MS = 60_000;

export interface RateResult {
  ok: boolean;
  retryAfterMs: number;
}

function minuteStamp(now: number): string {
  return String(Math.floor(now / MINUTE_MS));
}

/**
 * Reserva antes do envio; limite 0 significa sem limite próprio. Um slot perdido por
 * falha posterior custa menos que estourar a taxa e prejudicar a reputação do domínio.
 */
export async function reserveTenantRate(tenantId: string, ratePerMinute = 0): Promise<RateResult> {
  if (!ratePerMinute) return { ok: true, retryAfterMs: 0 };

  const now = Date.now();
  const key = `tenant:${tenantId}:rate:${minuteStamp(now)}`;
  const retryAfterMs = MINUTE_MS - (now % MINUTE_MS);

  const used = await redisConnection.incr(key);
  if (used === 1) await redisConnection.expire(key, 120);

  if (used > ratePerMinute) {
    await redisConnection.decr(key);
    return { ok: false, retryAfterMs };
  }
  return { ok: true, retryAfterMs: 0 };
}

/** Um worker que morre no meio do envio não devolve o slot; após o lease ele expira. */
const LEASE_MS = 5 * 60_000;

/** ZSET com o instante de cada envio; entradas mais velhas que o lease são podadas antes de contar. */
export async function acquireTenantSlot(tenantId: string, concurrency = 0, jobId = ''): Promise<boolean> {
  if (!concurrency) return true;

  const key = `tenant:${tenantId}:inflight`;
  const now = Date.now();

  await redisConnection.zremrangebyscore(key, 0, now - LEASE_MS);
  const inFlight = await redisConnection.zcard(key);
  if (inFlight >= concurrency) return false;

  await redisConnection.zadd(key, now, jobId || `${now}-${Math.trunc(now % 1000)}`);
  await redisConnection.expire(key, Math.ceil(LEASE_MS / 1000) * 2);
  return true;
}

/** Deve rodar em `finally`: um slot não devolvido trava o cliente até o lease vencer. */
export async function releaseTenantSlot(tenantId: string, concurrency = 0, jobId = ''): Promise<void> {
  if (!concurrency || !jobId) return;
  await redisConnection.zrem(`tenant:${tenantId}:inflight`, jobId);
}
