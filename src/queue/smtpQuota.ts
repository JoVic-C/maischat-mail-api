import { redisConnection } from '../config/redis';

/**
 * Cota de envio por servidor SMTP (dailyLimit / hourlyLimit do SmtpSettings).
 *
 * Os contadores ficam no Redis para valerem entre TODAS as instâncias do worker —
 * um contador em memória permitiria N× o limite com N réplicas. Cada chave expira
 * sozinha ao fim da janela, então não há rotina de limpeza.
 */

export interface QuotaResult {
  ok: boolean;
  /** Quando a cota estourou: em quanto tempo (ms) a janela vira e vale tentar de novo. */
  retryAfterMs: number;
  /** Qual limite estourou — só para log. */
  scope?: 'hourly' | 'daily';
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Janelas fixas em UTC: 'YYYYMMDDHH' para a hora e 'YYYYMMDD' para o dia. */
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

/** Incrementa uma chave e garante o TTL na primeira vez (janela fixa). */
async function bump(key: string, ttlSeconds: number): Promise<number> {
  const value = await redisConnection.incr(key);
  if (value === 1) await redisConnection.expire(key, ttlSeconds);
  return value;
}

/**
 * Reserva 1 envio para o servidor SMTP. Limite 0 = sem limite.
 *
 * A reserva acontece ANTES do envio: se o envio falhar depois, o slot é considerado
 * consumido. É o lado conservador de propósito — estourar o limite do provedor custa
 * reputação de domínio; perder um slot ocasional, não.
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
      // Devolve o slot da hora já reservado acima — o envio não vai acontecer agora.
      if (hourlyLimit > 0) await redisConnection.decr(hourKey);
      return { ok: false, retryAfterMs: msToNextDay(now), scope: 'daily' };
    }
  }

  return { ok: true, retryAfterMs: 0 };
}
