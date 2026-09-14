import { redisConnection } from '../config/redis';

/**
 * Cota de envio por servidor SMTP (dailyLimit / hourlyLimit). No Redis, para valer entre
 * instâncias; cada chave expira sozinha ao fim da janela.
 */

export interface QuotaResult {
  ok: boolean;
  retryAfterMs: number;
  scope?: 'hourly' | 'daily';
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Janelas fixas em UTC: 'YYYYMMDDHH' e 'YYYYMMDD'. */
function stamps(now: Date): { hour: string; day: string } {
  const iso = now.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, '');
  return { hour: day + iso.slice(11, 13), day };
}

function msToNextHour(now: number): number {
  return HOUR_MS - (now % HOUR_MS);
}

function msToNextDay(now: number): number {
  return DAY_MS - (now % DAY_MS);
}

async function bump(key: string, ttlSeconds: number): Promise<number> {
  const value = await redisConnection.incr(key);
  if (value === 1) await redisConnection.expire(key, ttlSeconds);
  return value;
}

/**
 * Reserva antes do envio; limite 0 significa sem limite. Estourar o limite do provedor
 * custa reputação de domínio, perder um slot ocasional não.
 */
export async function reserveSmtpQuota(smtpId: string, dailyLimit = 0, hourlyLimit = 0): Promise<QuotaResult> {
  if (!dailyLimit && !hourlyLimit) return { ok: true, retryAfterMs: 0 };

  const now = Date.now();
  const { hour, day } = stamps(new Date(now));
  const hourKey = `smtp:${smtpId}:h:${hour}`;
  const dayKey = `smtp:${smtpId}:d:${day}`;

  if (hourlyLimit > 0) {
    const used = await bump(hourKey, Math.ceil(msToNextHour(now) / 1000) + 60);
    if (used > hourlyLimit) {
      await redisConnection.decr(hourKey);
      return { ok: false, retryAfterMs: msToNextHour(now), scope: 'hourly' };
    }
  }

  if (dailyLimit > 0) {
    const used = await bump(dayKey, Math.ceil(msToNextDay(now) / 1000) + 60);
    if (used > dailyLimit) {
      await redisConnection.decr(dayKey);
      // Devolve o slot da hora reservado acima: o envio não acontece agora.
      if (hourlyLimit > 0) await redisConnection.decr(hourKey);
      return { ok: false, retryAfterMs: msToNextDay(now), scope: 'daily' };
    }
  }

  return { ok: true, retryAfterMs: 0 };
}
