/**
 * Veredito sobre o domínio de um email novo (importação, cadastro manual, formulário).
 * Duas etapas:
 * 1. DNS próprio (grátis): sem MX nem A, o domínio não recebe email.
 * 2. `checkDisposable` da EmailListVerify (1 crédito por domínio): pega domínio
 *    descartável e MX mal configurado, que passam no DNS.
 *
 * Falha, limite ou cota do provedor nunca reprovam: o domínio fica com o veredito do DNS.
 * O cache é global (Redis) porque o veredito de um domínio é público e não diz quem está
 * em qual base; só o domínio vai ao provedor, nunca o email.
 */
import { redisConnection } from '../config/redis';
import { captureError } from '../config/sentry';
import { dnsAcceptsMail, domainOf } from '../utils/emailHygiene';
import { logger, logSideEffect } from '../utils/logger';
import emailListVerify, { EmailVerifyProviderError } from './emailListVerify.client';

export type DomainVerdict = 'ok' | 'disposable' | 'no-mail';

export interface DomainCheckOptions {
  /**
   * Quanto esperar por uma vaga no limite por segundo do provedor. Sem vaga a tempo, fica o
   * veredito do DNS. A importação espera mais; cadastro e formulário, pouco.
   */
  waitForSlotMs?: number;
}

const CACHE_PREFIX = 'domain-check:v1:';
const DAY_S = 24 * 60 * 60;
/** Curto: um domínio que corrige o MX volta a receber no dia seguinte. */
const NO_MAIL_TTL_S = DAY_S;
const MAX_DOMAIN_LENGTH = 255;

/** Resultado da EmailListVerify que vira veredito; o resto (`unknown`) é inconclusivo e não é cobrado. */
const PROVIDER_VERDICT: Record<string, DomainVerdict> = {
  ok: 'ok',
  disposable: 'disposable',
  dead_server: 'no-mail',
  invalid_mx: 'no-mail',
};

const VERDICTS = new Set<DomainVerdict>(['ok', 'disposable', 'no-mail']);

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function ttlSeconds(): number {
  return (numberEnv('DOMAIN_CHECK_TTL_DAYS', 30) || 30) * DAY_S;
}

/** 0 = sem limite. */
function dailyLimit(): number {
  return numberEnv('DOMAIN_CHECK_DAILY_LIMIT', 5_000);
}

/** A API aceita 50 por segundo nesse endpoint; a margem cobre relógio e rede. */
function ratePerSecond(): number {
  return numberEnv('DOMAIN_CHECK_RATE_PER_SEC', 40) || 40;
}

function dayPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

export class DomainCheckService {
  /** Consultas simultâneas ao mesmo domínio no processo viram uma só (lote de importação). */
  private readonly inFlight = new Map<string, Promise<DomainVerdict>>();

  get providerEnabled(): boolean {
    return emailListVerify.configured && process.env.DOMAIN_CHECK_ENABLED !== 'false';
  }

  checkEmail(email: string, opts: DomainCheckOptions = {}): Promise<DomainVerdict> {
    return this.check(domainOf(email), opts);
  }

  async check(rawDomain: string, opts: DomainCheckOptions = {}): Promise<DomainVerdict> {
    const domain = normalizeDomain(rawDomain);
    if (!domain || domain.length > MAX_DOMAIN_LENGTH) return 'no-mail';

    const pending = this.inFlight.get(domain);
    if (pending) return pending;

    const promise = this.resolve(domain, opts).finally(() => this.inFlight.delete(domain));
    this.inFlight.set(domain, promise);
    return promise;
  }

  private async resolve(domain: string, opts: DomainCheckOptions): Promise<DomainVerdict> {
    const cached = await this.readCache(domain);
    if (cached) return cached;

    if (!(await dnsAcceptsMail(domain))) {
      await this.writeCache(domain, 'no-mail', NO_MAIL_TTL_S);
      return 'no-mail';
    }

    // Aprovado só pelo DNS não vai para o cache: senão, ligar o provedor depois não teria efeito.
    if (!this.providerEnabled) return 'ok';
    return this.askProvider(domain, opts.waitForSlotMs ?? 0);
  }

  private async askProvider(domain: string, waitForSlotMs: number): Promise<DomainVerdict> {
    const period = dayPeriod();
    if (!(await this.reserveDaily(period))) return 'ok';
    if (!(await this.acquireRateSlot(waitForSlotMs))) {
      await this.releaseDaily(period);
      return 'ok';
    }

    let result: string;
    try {
      ({ result } = await emailListVerify.checkDisposable(domain));
    } catch (err) {
      await this.releaseDaily(period);
      this.reportProviderError(err, domain);
      return 'ok';
    }

    const verdict = PROVIDER_VERDICT[result];
    if (!verdict) {
      await this.releaseDaily(period);
      return 'ok';
    }
    await this.writeCache(domain, verdict, verdict === 'no-mail' ? NO_MAIL_TTL_S : ttlSeconds());
    return verdict;
  }

  /** Redis fora não pode travar cadastro nem importação: vira cache vazio. */
  private async readCache(domain: string): Promise<DomainVerdict | null> {
    try {
      const value = await redisConnection.get(CACHE_PREFIX + domain);
      return value && VERDICTS.has(value as DomainVerdict) ? (value as DomainVerdict) : null;
    } catch (err) {
      logSideEffect('domainCheck.readCache', err, { domain });
      return null;
    }
  }

  private async writeCache(domain: string, verdict: DomainVerdict, ttl: number): Promise<void> {
    try {
      await redisConnection.set(CACHE_PREFIX + domain, verdict, 'EX', ttl);
    } catch (err) {
      logSideEffect('domainCheck.writeCache', err, { domain });
    }
  }

  /** Teto diário global de créditos; sem Redis, não consulta (não dá para contar o gasto). */
  private async reserveDaily(period: string): Promise<boolean> {
    const limit = dailyLimit();
    try {
      const key = `domain-check:daily:${period}`;
      const used = await redisConnection.incr(key);
      if (used === 1) await redisConnection.expire(key, 2 * DAY_S);
      if (limit && used > limit) {
        await redisConnection.decr(key);
        if (used === limit + 1) {
          logger.warn(`domainCheck: teto diário de ${limit} consultas atingido; segue só com DNS até amanhã (UTC)`);
        }
        return false;
      }
      return true;
    } catch (err) {
      logSideEffect('domainCheck.reserveDaily', err, { period });
      return false;
    }
  }

  private async releaseDaily(period: string): Promise<void> {
    try {
      await redisConnection.decr(`domain-check:daily:${period}`);
    } catch (err) {
      logSideEffect('domainCheck.releaseDaily', err, { period });
    }
  }

  /** Janela fixa de 1s somando todos os processos; espera a próxima janela até o prazo. */
  private async acquireRateSlot(maxWaitMs: number): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    try {
      for (;;) {
        const second = Math.floor(Date.now() / 1000);
        const key = `domain-check:rate:${second}`;
        const used = await redisConnection.incr(key);
        if (used === 1) await redisConnection.expire(key, 2);
        if (used <= ratePerSecond()) return true;

        // O jitter espalha quem acorda junto na mesma janela.
        const wait = (second + 1) * 1000 - Date.now() + Math.floor(Math.random() * 50);
        if (Date.now() + wait > deadline) return false;
        await sleep(wait);
      }
    } catch (err) {
      logSideEffect('domainCheck.rateSlot', err);
      return false;
    }
  }

  private reportProviderError(err: unknown, domain: string): void {
    logSideEffect('domainCheck.provider', err, { domain });
    const transient = err instanceof EmailVerifyProviderError && err.transient;
    if (!transient) captureError(err, { scope: 'domainCheck.provider', domain });
  }
}

export default new DomainCheckService();
