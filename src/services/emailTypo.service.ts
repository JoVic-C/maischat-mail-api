/**
 * Erro de digitação no domínio dos contatos (`docs/prd-erro-digitacao.md`): monta o contexto
 * do cliente para o detector (`utils/emailTypo`) e faz a revisão por domínio (listar,
 * corrigir, manter). Roda sempre no contexto de um cliente.
 */
import type { AnyBulkWriteOperation, Types } from 'mongoose';
import { redisConnection } from '../config/redis';
import { requireTenantId } from '../config/tenantContext';
import { BadRequestError, ValidationError } from '../errors';
import AcceptedDomain from '../models/AcceptedDomain';
import Contact from '../models/Contact';
import { dnsAcceptsMail, domainOf } from '../utils/emailHygiene';
import { normalizeTypoDomain, suggestDomain, type TypoContext } from '../utils/emailTypo';
import { TYPO_RESULT } from '../utils/emailVerification';
import { logSideEffect } from '../utils/logger';
import { escapeRegex } from '../utils/regex';

/** Um domínio com menos contatos que isto não serve de alvo para os parecidos com ele. */
const REFERENCE_MIN_CONTACTS = 10;
const REFERENCE_LIMIT = 2000;
const CACHE_PREFIX = 'typo-ref:v1:';
const CACHE_TTL_S = 6 * 60 * 60;
/** Cópia em memória: o webhook e o cadastro consultam a cada email. */
const MEMORY_TTL_MS = 5 * 60 * 1000;
const SUSPECT_LIMIT = 500;
const FIX_BATCH = 500;
const DOMAIN_FORMAT = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface SuspectDomain {
  domain: string;
  count: number;
  suggestion: string;
}

export interface FixDomainResult {
  fixed: number;
  /** Já existia um contato com o email corrigido: este ficou como estava. */
  conflicts: number;
}

interface ContactRow {
  _id: Types.ObjectId;
  email: string;
}

function domainFilter(domain: string): Record<string, unknown> {
  return { email: { $regex: `@${escapeRegex(domain)}$` } };
}

export class EmailTypoService {
  private readonly memory = new Map<string, { expiresAt: number; references: Map<string, number> }>();

  /** Contexto do detector para o cliente atual: domínios frequentes da base e aceitos. */
  async context(): Promise<Required<TypoContext>> {
    const accepted = await this.acceptedDomains();
    return { accepted, references: await this.references(accepted) };
  }

  /** Domínio sugerido para o email, ou `null` se não há suspeita. */
  async suggestionFor(email: string, ctx?: TypoContext): Promise<string | null> {
    const domain = domainOf(email);
    if (!domain) return null;
    return suggestDomain(domain, ctx ?? (await this.context()));
  }

  async listSuspects(): Promise<SuspectDomain[]> {
    const accepted = await this.acceptedDomains();
    const counts = await this.domainCounts();
    const references = this.referencesFrom(counts, accepted);
    await this.remember(references);

    const suspects: SuspectDomain[] = [];
    for (const [domain, count] of counts) {
      const suggestion = suggestDomain(domain, { accepted, references });
      if (suggestion) suspects.push({ domain, count, suggestion });
    }
    return suspects.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)).slice(0, SUSPECT_LIMIT);
  }

  /**
   * Troca o domínio de todos os contatos de `from`. Quem colidiria com um contato que já
   * existe no endereço corrigido fica como está (o índice único é por cliente e email).
   */
  async fixDomain(rawFrom: string, rawTo: string): Promise<FixDomainResult> {
    const from = normalizeTypoDomain(rawFrom);
    const to = normalizeTypoDomain(rawTo);
    await this.assertFixable(from, to);

    let fixed = 0;
    let conflicts = 0;
    let lastId: Types.ObjectId | null = null;

    for (;;) {
      const filter: Record<string, unknown> = domainFilter(from);
      if (lastId) filter._id = { $gt: lastId };
      const batch = await Contact.find(filter).select('email').sort({ _id: 1 }).limit(FIX_BATCH).lean<ContactRow[]>();
      if (!batch.length) break;
      lastId = batch[batch.length - 1]._id;

      const result = await this.moveBatch(batch, to);
      fixed += result.fixed;
      conflicts += result.conflicts;
    }

    await this.invalidate();
    return { fixed, conflicts };
  }

  /** O domínio deixa de ser suspeito para este cliente e os contatos dele saem da revisão. */
  async acceptDomain(rawDomain: string, userId: string | null): Promise<{ released: number }> {
    const domain = normalizeTypoDomain(rawDomain);
    if (!DOMAIN_FORMAT.test(domain)) {
      throw new ValidationError([{ field: 'domain', message: 'Domínio inválido.' }]);
    }

    await AcceptedDomain.updateOne(
      { domain },
      { $setOnInsert: { domain, acceptedBy: userId ?? null } },
      { upsert: true }
    );
    const released = await Contact.updateMany(
      { ...domainFilter(domain), 'verification.result': TYPO_RESULT },
      { $unset: { verification: 1 } }
    );
    await this.invalidate();
    return { released: released.modifiedCount ?? 0 };
  }

  private async assertFixable(from: string, to: string): Promise<void> {
    if (!DOMAIN_FORMAT.test(to)) {
      throw new ValidationError([{ field: 'to', message: 'Domínio de destino inválido.' }]);
    }
    if (from === to) {
      throw new ValidationError([{ field: 'to', message: 'O domínio de destino é igual ao de origem.' }]);
    }
    // Só domínio apontado pelo detector: a rota não serve para renomear um domínio qualquer.
    if (!suggestDomain(from, await this.context())) {
      throw new BadRequestError(`O domínio ${from} não está entre os suspeitos de erro de digitação.`);
    }
    if (!(await dnsAcceptsMail(to))) {
      throw new ValidationError([{ field: 'to', message: `O domínio ${to} não recebe emails.` }]);
    }
  }

  private async moveBatch(batch: ContactRow[], to: string): Promise<FixDomainResult> {
    const target = new Map(batch.map((c) => [String(c._id), `${c.email.slice(0, c.email.lastIndexOf('@'))}@${to}`]));
    const taken = new Set(
      (
        await Contact.find({ email: { $in: [...target.values()] } })
          .select('email')
          .lean<ContactRow[]>()
      ).map((c) => c.email)
    );

    const tenantId = requireTenantId();
    const moves = batch.filter((c) => !taken.has(target.get(String(c._id)) as string));
    const ops: AnyBulkWriteOperation[] = moves.map((c) => ({
      updateOne: {
        // `bulkWrite` não passa pelos hooks do tenantScope: o filtro por cliente vai à mão.
        filter: { _id: c._id, ...(tenantId ? { tenantId } : {}) },
        update: { $set: { email: target.get(String(c._id)) }, $unset: { verification: 1 } },
      },
    }));
    if (!ops.length) return { fixed: 0, conflicts: batch.length };

    try {
      const result = await Contact.bulkWrite(ops, { ordered: false });
      return { fixed: result.modifiedCount, conflicts: batch.length - moves.length };
    } catch (err) {
      // Corrida com um cadastro do mesmo endereço: o que bateu no índice único é conflito.
      const bulk = err as { code?: number; result?: { modifiedCount?: number }; writeErrors?: unknown[] };
      const writeErrors = bulk.writeErrors ?? [];
      if (bulk.code !== 11000 && !writeErrors.length) throw err;
      const fixed = bulk.result?.modifiedCount ?? moves.length - writeErrors.length;
      return { fixed, conflicts: batch.length - fixed };
    }
  }

  private async acceptedDomains(): Promise<Set<string>> {
    const docs = await AcceptedDomain.find().select('domain').lean<{ domain: string }[]>();
    return new Set(docs.map((d) => d.domain));
  }

  /** Quantidade de contatos por domínio na base do cliente. */
  private async domainCounts(): Promise<Map<string, number>> {
    const rows = await Contact.aggregate<{ _id: string; count: number }>([
      { $project: { _id: 0, domain: { $toLower: { $arrayElemAt: [{ $split: ['$email', '@'] }, -1] } } } },
      { $group: { _id: '$domain', count: { $sum: 1 } } },
    ]).allowDiskUse(true);
    return new Map(rows.filter((r) => r._id).map((r) => [r._id, r.count]));
  }

  /**
   * Domínios frequentes que servem de alvo. Os que o próprio detector já acusa (por
   * provedor ou final inexistente) ficam de fora: `iclou.com` com 80 contatos não pode
   * virar referência.
   */
  private referencesFrom(counts: Map<string, number>, accepted: Set<string>): Map<string, number> {
    const frequent = [...counts]
      .filter(([domain, count]) => count >= REFERENCE_MIN_CONTACTS && !suggestDomain(domain, { accepted }))
      .sort((a, b) => b[1] - a[1])
      .slice(0, REFERENCE_LIMIT);
    return new Map(frequent);
  }

  private async references(accepted: Set<string>): Promise<Map<string, number>> {
    const key = this.cacheKey();
    if (!key) return new Map();

    const inMemory = this.memory.get(key);
    if (inMemory && inMemory.expiresAt > Date.now()) return inMemory.references;

    const cached = await this.readCache(key);
    if (cached) {
      this.memory.set(key, { expiresAt: Date.now() + MEMORY_TTL_MS, references: cached });
      return cached;
    }

    const references = this.referencesFrom(await this.domainCounts(), accepted);
    await this.remember(references);
    return references;
  }

  private async remember(references: Map<string, number>): Promise<void> {
    const key = this.cacheKey();
    if (!key) return;
    this.memory.set(key, { expiresAt: Date.now() + MEMORY_TTL_MS, references });
    try {
      await redisConnection.set(key, JSON.stringify([...references]), 'EX', CACHE_TTL_S);
    } catch (err) {
      logSideEffect('emailTypo.writeCache', err);
    }
  }

  private async readCache(key: string): Promise<Map<string, number> | null> {
    try {
      const raw = await redisConnection.get(key);
      return raw ? new Map(JSON.parse(raw) as [string, number][]) : null;
    } catch (err) {
      logSideEffect('emailTypo.readCache', err);
      return null;
    }
  }

  private async invalidate(): Promise<void> {
    const key = this.cacheKey();
    if (!key) return;
    this.memory.delete(key);
    try {
      await redisConnection.del(key);
    } catch (err) {
      logSideEffect('emailTypo.invalidate', err);
    }
  }

  /** Sem cliente no contexto (modo system) não há base para comparar. */
  private cacheKey(): string | null {
    const tenantId = requireTenantId();
    return tenantId ? CACHE_PREFIX + String(tenantId) : null;
  }
}

export default new EmailTypoService();
