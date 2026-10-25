/**
 * Verificação de caixa postal com a EmailListVerify: unitária (cadastro manual e formulário)
 * e em lote (lista inteira, assíncrona no provedor). Regras de custo:
 * - um email verificado há menos de EMAIL_VERIFY_TTL_DAYS não volta ao provedor;
 * - cada cliente tem uma cota mensal (EMAIL_VERIFY_MONTHLY_LIMIT), porque a chave é única;
 * - falha do provedor nunca bloqueia cadastro nem envio: o contato fica sem verificação.
 */
import type { AnyBulkWriteOperation, Types } from 'mongoose';
import { redisConnection } from '../config/redis';
import { captureError } from '../config/sentry';
import { requireTenantId } from '../config/tenantContext';
import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import Contact from '../models/Contact';
import List from '../models/List';
import VerificationJob, {
  ACTIVE_VERIFICATION_STATUSES,
  type IVerificationJob,
  type VerificationCounters,
  type VerificationJobDocument,
} from '../models/VerificationJob';
import { enqueueVerificationStep, type VerificationStep } from '../queue/verification.queue';
import { type ContactVerification, classifyElvResult, verificationReason } from '../utils/emailVerification';
import { logger, logSideEffect } from '../utils/logger';
import emailListVerify, { EmailVerifyProviderError } from './emailListVerify.client';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Teto de linhas por lista aceito pela API. */
const MAX_LIST_SIZE = 1_000_000;
const APPLY_BATCH = 500;
const FIRST_POLL_MS = 15_000;
const POLL_MS = 30_000;
/** Com qualidade padrão o provedor não passa disso; além, a lista é dada como perdida. */
const MAX_VERIFYING_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60_000;
const MAX_TRANSIENT_RETRIES = 10;

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function ttlDays(): number {
  return numberEnv('EMAIL_VERIFY_TTL_DAYS', 90) || 90;
}

/** 0 = sem limite. */
function monthlyLimit(): number {
  return numberEnv('EMAIL_VERIFY_MONTHLY_LIMIT', 10_000);
}

/** A API aceita 10 verificações unitárias por segundo por chave; a margem cobre relógio e rede. */
function ratePerSecond(): number {
  return numberEnv('EMAIL_VERIFY_RATE_PER_SEC', 8) || 8;
}

function monthPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function quotaKey(tenantId: string, period: string): string {
  return `email-verify:quota:${tenantId}:${period}`;
}

function staleBefore(): Date {
  return new Date(Date.now() - ttlDays() * DAY_MS);
}

function emptyCounters(): VerificationCounters {
  return { deliverable: 0, undeliverable: 0, risky: 0, unknown: 0 };
}

function currentTenantId(): string {
  const tenantId = requireTenantId();
  if (!tenantId) throw new BadRequestError('A verificação de emails exige o contexto de um cliente.');
  return String(tenantId);
}

export interface VerificationQuota {
  limit: number;
  used: number;
}

export interface ListVerificationOverview {
  enabled: boolean;
  quota: VerificationQuota;
  /** Contatos ativos da lista sem verificação recente: o custo de verificar agora. */
  pending: number;
  ttlDays: number;
  job: IVerificationJob | null;
}

export class EmailVerificationService {
  get enabled(): boolean {
    return emailListVerify.configured;
  }

  /** Verificação recente o bastante para não gastar crédito de novo. */
  isFresh(verification?: ContactVerification | null): boolean {
    return Boolean(verification?.checkedAt && verification.checkedAt > staleBefore());
  }

  describe(verification: ContactVerification): string {
    return verificationReason(verification.result);
  }

  /**
   * Verificação unitária. Devolve `null` quando não dá para verificar agora (desligada, cota
   * ou limite de requisições esgotados, provedor fora): quem chama segue sem bloquear.
   */
  async verifySingle(email: string): Promise<ContactVerification | null> {
    if (!this.enabled) return null;
    const tenantId = currentTenantId();
    if (!(await this.takeRateSlot())) {
      logger.warn('emailVerification.single: limite por segundo atingido; contato segue sem verificação');
      return null;
    }

    const period = monthPeriod();
    if (!(await this.reserveQuota(tenantId, period, 1))) return null;

    let raw: string;
    try {
      raw = await emailListVerify.verifyEmail(email);
    } catch (err) {
      await this.releaseQuota(tenantId, period, 1);
      this.reportProviderError('emailVerification.single', err);
      return null;
    }

    const status = classifyElvResult(raw);
    // Resultado inconclusivo não é cobrado pelo provedor; também não conta na cota.
    if (status === 'unknown') await this.releaseQuota(tenantId, period, 1);
    return { status, result: raw, checkedAt: new Date() };
  }

  async getQuota(): Promise<VerificationQuota> {
    const used = Number(await redisConnection.get(quotaKey(currentTenantId(), monthPeriod()))) || 0;
    return { limit: monthlyLimit(), used: Math.max(0, used) };
  }

  async overview(listId: string): Promise<ListVerificationOverview> {
    const [quota, pending, job] = await Promise.all([
      this.getQuota(),
      Contact.countDocuments(this.pendingQuery(listId)),
      VerificationJob.findOne({ listId }).sort({ createdAt: -1 }).lean<IVerificationJob>(),
    ]);
    return { enabled: this.enabled, quota, pending, ttlDays: ttlDays(), job: job ?? null };
  }

  async startListVerification(listId: string, userId: string): Promise<VerificationJobDocument> {
    if (!this.enabled) {
      throw new BadRequestError('A verificação de emails não está configurada nesta instalação.');
    }
    const tenantId = currentTenantId();
    if (!(await List.exists({ _id: listId }))) throw new NotFoundError('Lista não encontrada.');

    const running = await VerificationJob.exists({ listId, status: { $in: ACTIVE_VERIFICATION_STATUSES } });
    if (running) throw new ConflictError('Esta lista já está sendo verificada.');

    const pending = await Contact.countDocuments(this.pendingQuery(listId));
    if (!pending) {
      throw new BadRequestError(
        `Não há o que verificar: os contatos ativos desta lista já foram verificados nos últimos ${ttlDays()} dias.`
      );
    }
    if (pending > MAX_LIST_SIZE) {
      throw new BadRequestError('A lista passa de 1 milhão de contatos a verificar, o limite do provedor.');
    }

    const period = monthPeriod();
    if (!(await this.reserveQuota(tenantId, period, pending))) {
      const { limit, used } = await this.getQuota();
      throw new BadRequestError(
        `Cota mensal de verificações insuficiente: esta lista precisa de ${pending}, restam ${Math.max(0, limit - used)} de ${limit}.`
      );
    }

    const job = await VerificationJob.create({
      listId,
      createdBy: userId,
      status: 'queued',
      reserved: pending,
      quotaPeriod: period,
      counters: emptyCounters(),
    });
    await enqueueVerificationStep(tenantId, job.id, 'upload');
    return job;
  }

  /** Executado pelo worker, já no escopo do cliente. */
  async runStep(jobId: string, step: VerificationStep, attempt: number): Promise<void> {
    const job = await VerificationJob.findById(jobId);
    if (!job) return;

    try {
      if (step === 'upload') await this.upload(job, attempt);
      else if (step === 'poll') await this.poll(job);
      else await this.apply(job);
    } catch (err) {
      await this.handleStepError(job, step, attempt, err);
    }
  }

  async markFailed(jobId: string, message: string): Promise<void> {
    await VerificationJob.updateOne(
      { _id: jobId, status: { $in: ACTIVE_VERIFICATION_STATUSES } },
      { status: 'failed', error: message, finishedAt: new Date() }
    );
  }

  private pendingQuery(listId: string | Types.ObjectId): Record<string, unknown> {
    return {
      lists: listId,
      status: 'active',
      $or: [
        { verification: { $exists: false } },
        { verification: null },
        { 'verification.checkedAt': { $lt: staleBefore() } },
      ],
    };
  }

  private async upload(job: VerificationJobDocument, attempt: number): Promise<void> {
    if (job.status === 'uploading') {
      // Reentrega após queda do worker: a lista pode já estar no provedor; reenviar cobraria de novo.
      await this.fail(
        job,
        'A verificação foi interrompida durante o envio ao provedor. Confira o painel da EmailListVerify antes de tentar de novo.'
      );
      return;
    }
    if (job.status !== 'queued') return;

    job.status = 'uploading';
    job.startedAt = job.startedAt ?? new Date();
    await job.save();

    const emails: string[] = [];
    const cursor = Contact.find(this.pendingQuery(job.listId)).select('email').lean<{ email: string }[]>().cursor();
    for await (const contact of cursor) emails.push((contact as { email: string }).email);

    const unused = job.reserved - emails.length;
    if (unused > 0) await this.releaseQuota(String(job.tenantId), job.quotaPeriod, unused);

    if (!emails.length) {
      job.status = 'done';
      job.total = 0;
      job.reserved = 0;
      job.finishedAt = new Date();
      await job.save();
      return;
    }

    let providerListId: string;
    try {
      providerListId = await emailListVerify.uploadList(
        `email\n${emails.join('\n')}\n`,
        `mailpulse-${job.id}-${attempt}.csv`
      );
    } catch (err) {
      // Excesso de requisições é recusado antes de processar: dá para tentar de novo sem risco.
      if (err instanceof EmailVerifyProviderError && err.kind === 'rate') {
        job.status = 'queued';
        await job.save();
      }
      throw err;
    }

    job.providerListId = providerListId;
    job.total = emails.length;
    job.reserved = emails.length;
    job.status = 'verifying';
    await job.save();
    await enqueueVerificationStep(String(job.tenantId), job.id, 'poll', { delayMs: FIRST_POLL_MS });
  }

  private async poll(job: VerificationJobDocument): Promise<void> {
    if (job.status !== 'verifying') return;
    const { status, progress } = await emailListVerify.getProgress(job.providerListId);

    if (status === 'error') {
      // O provedor devolve todos os créditos de uma lista que falhou.
      await this.releaseQuota(String(job.tenantId), job.quotaPeriod, job.reserved);
      job.reserved = 0;
      await this.fail(job, 'A EmailListVerify não conseguiu processar a lista. Os créditos foram devolvidos.');
      return;
    }

    if (status === 'finished') {
      job.status = 'applying';
      job.progress = 100;
      await job.save();
      await enqueueVerificationStep(String(job.tenantId), job.id, 'apply');
      return;
    }

    const startedAt = (job.startedAt ?? job.createdAt).getTime();
    if (Date.now() - startedAt > MAX_VERIFYING_MS) {
      await this.fail(job, 'A EmailListVerify não concluiu a verificação em 24 horas.');
      return;
    }

    job.progress = Math.min(99, Math.max(job.progress, progress));
    await job.save();
    await enqueueVerificationStep(String(job.tenantId), job.id, 'poll', { delayMs: POLL_MS });
  }

  /** Idempotente: reaplicar depois de uma queda grava os mesmos valores. */
  private async apply(job: VerificationJobDocument): Promise<void> {
    if (job.status !== 'applying') return;

    const tenantId = requireTenantId();
    const counters = emptyCounters();
    const checkedAt = new Date();
    let ops: AnyBulkWriteOperation[] = [];

    const flush = async (): Promise<void> => {
      if (!ops.length) return;
      await Contact.bulkWrite(ops, { ordered: false });
      ops = [];
    };

    for await (const row of emailListVerify.downloadResults(job.providerListId)) {
      const status = classifyElvResult(row.result);
      counters[status]++;
      ops.push({
        updateOne: {
          // `bulkWrite` não passa pelos hooks do tenantScope: o filtro por cliente entra à mão.
          filter: { tenantId, email: row.email },
          update: { $set: { verification: { status, result: row.result, checkedAt } } },
        },
      });
      if (ops.length >= APPLY_BATCH) await flush();
    }
    await flush();

    // Inconclusivos não são cobrados pelo provedor.
    if (counters.unknown) await this.releaseQuota(String(job.tenantId), job.quotaPeriod, counters.unknown);

    job.counters = counters;
    job.status = 'done';
    job.finishedAt = new Date();
    await job.save();

    // O provedor guarda a lista com os emails do cliente; apagar é minimização de dados.
    try {
      await emailListVerify.deleteList(job.providerListId);
    } catch (err) {
      logSideEffect('emailVerification.deleteList', err, { verificationJobId: job.id });
    }
    logger.info(
      `✓ Verificação ${job.id}: ${counters.deliverable} válidos, ${counters.undeliverable} inválidos, ` +
        `${counters.risky} arriscados, ${counters.unknown} inconclusivos.`
    );
  }

  private async handleStepError(
    job: VerificationJobDocument,
    step: VerificationStep,
    attempt: number,
    err: unknown
  ): Promise<void> {
    const transient = err instanceof EmailVerifyProviderError && err.transient;
    // Envio que estourou o tempo pode ter chegado ao provedor: não reenvia às cegas.
    const retryable = transient && !(step === 'upload' && job.status === 'uploading');

    if (retryable && attempt < MAX_TRANSIENT_RETRIES) {
      logger.warn(`↻ Verificação ${job.id}: ${(err as Error).message} — nova tentativa em ${RETRY_MS / 1000}s.`);
      await enqueueVerificationStep(String(job.tenantId), job.id, step, { delayMs: RETRY_MS, attempt: attempt + 1 });
      return;
    }

    // Só devolve a cota do que comprovadamente não chegou ao provedor.
    if (job.status === 'queued') {
      await this.releaseQuota(String(job.tenantId), job.quotaPeriod, job.reserved);
      job.reserved = 0;
    }

    this.reportProviderError('emailVerification.step', err, { verificationJobId: job.id, step });
    const message =
      err instanceof EmailVerifyProviderError ? err.message : 'Falha inesperada ao verificar a lista. Avise o suporte.';
    await this.fail(job, message);
  }

  private async fail(job: VerificationJobDocument, message: string): Promise<void> {
    job.status = 'failed';
    job.error = message;
    job.finishedAt = new Date();
    await job.save();
  }

  /** Erro de chave, crédito ou conta precisa de gente: vai para o Sentry. Passageiro só loga. */
  private reportProviderError(scope: string, err: unknown, extra: Record<string, unknown> = {}): void {
    logSideEffect(scope, err, extra);
    const transient = err instanceof EmailVerifyProviderError && err.transient;
    if (!transient) captureError(err, { scope, ...extra });
  }

  private async takeRateSlot(): Promise<boolean> {
    const key = `email-verify:rate:${Math.floor(Date.now() / 1000)}`;
    const used = await redisConnection.incr(key);
    if (used === 1) await redisConnection.expire(key, 2);
    return used <= ratePerSecond();
  }

  /** Mesmo padrão de janela fixa do tenantQuota: soma, e desfaz se passou do teto. */
  private async reserveQuota(tenantId: string, period: string, amount: number): Promise<boolean> {
    const key = quotaKey(tenantId, period);
    const used = await redisConnection.incrby(key, amount);
    if (used === amount) await redisConnection.expire(key, 40 * 24 * 60 * 60);
    const limit = monthlyLimit();
    if (limit && used > limit) {
      await redisConnection.decrby(key, amount);
      return false;
    }
    return true;
  }

  private async releaseQuota(tenantId: string, period: string, amount: number): Promise<void> {
    if (amount <= 0 || !period) return;
    try {
      await redisConnection.decrby(quotaKey(tenantId, period), amount);
    } catch (err) {
      logSideEffect('emailVerification.releaseQuota', err, { tenantId, amount });
    }
  }
}

export default new EmailVerificationService();
