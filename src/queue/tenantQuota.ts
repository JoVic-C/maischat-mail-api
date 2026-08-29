import { redisConnection } from '../config/redis';

/**
 * Fatia de capacidade de cada cliente dentro do motor de envio.
 *
 * O worker é um processo só, com um número fixo de slots (PlatformSettings). Estes
 * limites repartem essa piscina entre os clientes — não criam capacidade nova.
 * Ficam no Redis para valerem entre todas as instâncias do worker.
 *
 * São dois controles diferentes:
 * - **taxa por minuto**: contador de janela fixa, igual à cota de SMTP;
 * - **envios simultâneos**: semáforo, que precisa ser DEVOLVIDO ao fim do envio.
 */

const MINUTE_MS = 60_000;

export interface RateResult {
  ok: boolean;
  /** Quanto falta (ms) para a janela do minuto virar. */
  retryAfterMs: number;
}

/** Janela fixa de 1 minuto, em UTC. */
function minuteStamp(now: number): string {
  return String(Math.floor(now / MINUTE_MS));
}

/**
 * Reserva 1 envio na taxa por minuto do cliente. Limite 0 = sem limite próprio.
 *
 * Igual à cota de SMTP: reserva ANTES do envio. Um slot perdido por falha posterior
 * custa menos que estourar a taxa combinada e derrubar a reputação do domínio.
 */
export async function reserveTenantRate(tenantId: string, ratePerMinute = 0): Promise<RateResult> {
  if (!ratePerMinute) return { ok: true, retryAfterMs: 0 };

  const now = Date.now();
  const key = `tenant:${tenantId}:rate:${minuteStamp(now)}`;
  const retryAfterMs = MINUTE_MS - (now % MINUTE_MS);

  const used = await redisConnection.incr(key);
  if (used === 1) await redisConnection.expire(key, 120); // a janela dura 1 min; 2 min cobre o relógio

  if (used > ratePerMinute) {
    await redisConnection.decr(key);
    return { ok: false, retryAfterMs };
  }
  return { ok: true, retryAfterMs: 0 };
}

/**
 * Quanto tempo um envio pode segurar um slot antes de ser considerado abandonado.
 * Existe porque um worker que morre no meio do envio não devolve o slot — sem isso,
 * o cliente ficaria travado até alguém limpar o Redis à mão.
 */
const LEASE_MS = 5 * 60_000;

/**
 * Tenta ocupar um slot de envio simultâneo do cliente.
 *
 * Usa um ZSET com o instante de cada envio em andamento: entradas mais velhas que o
 * lease são podadas antes de contar, então um slot vazado se resolve sozinho.
 * Devolve `false` quando o cliente já está no teto dele.
 */
export async function acquireTenantSlot(tenantId: string, concurrency = 0, jobId = ''): Promise<boolean> {
  if (!concurrency) return true;

  const key = `tenant:${tenantId}:inflight`;
  const now = Date.now();

  await redisConnection.zremrangebyscore(key, 0, now - LEASE_MS); // poda os abandonados
  const inFlight = await redisConnection.zcard(key);
  if (inFlight >= concurrency) return false;

  await redisConnection.zadd(key, now, jobId || `${now}-${Math.trunc(now % 1000)}`);
  await redisConnection.expire(key, Math.ceil(LEASE_MS / 1000) * 2);
  return true;
}

/** Devolve o slot. DEVE rodar em `finally` — um slot não devolvido trava o cliente. */
export async function releaseTenantSlot(tenantId: string, concurrency = 0, jobId = ''): Promise<void> {
  if (!concurrency || !jobId) return;
  await redisConnection.zrem(`tenant:${tenantId}:inflight`, jobId);
}
