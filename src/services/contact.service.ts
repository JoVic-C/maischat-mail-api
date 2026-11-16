import { type AnyBulkWriteOperation, Types } from 'mongoose';
import { requireTenantId } from '../config/tenantContext';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import Contact, { type ContactDocument, type IContact } from '../models/Contact';
import List from '../models/List';
import type { CsvRow } from '../utils/csv';
import { domainOf, EMAIL_RE } from '../utils/emailHygiene';
import { suggestDomain, type TypoContext } from '../utils/emailTypo';
import {
  type ContactVerification,
  disposableDomainVerification,
  typoVerification,
  type VerificationStatus,
} from '../utils/emailVerification';
import { decrypt } from '../utils/fieldCrypto';
import { escapeRegex } from '../utils/regex';
import domainCheck, { type DomainVerdict } from './domainCheck.service';
import emailTypoService from './emailTypo.service';
import emailVerificationService from './emailVerification.service';

/** Cadastro manual é interativo: espera pouco por vaga no limite do provedor. */
const INTERACTIVE_DOMAIN_WAIT_MS = 1000;
/** Na importação vale esperar a próxima janela: o veredito vai para o cache. */
const IMPORT_DOMAIN_WAIT_MS = 10_000;
/** Domínios consultados em paralelo por lote; a vazão real é o limite por segundo do provedor. */
const IMPORT_DOMAIN_CONCURRENCY = 20;

export interface CreateContactInput {
  email: string;
  name?: string;
  phone?: string;
  company?: string;
  lists?: string[];
  status?: IContact['status'];
  metadata?: Record<string, string>;
  /**
   * A pessoa viu o aviso de possível erro de digitação no domínio e decidiu manter o email.
   * Sem isso, um domínio suspeito entra marcado e fora das campanhas.
   */
  keepEmail?: boolean;
}

export type UpdateContactInput = Partial<CreateContactInput>;
export type SaveContactInput = CreateContactInput & { id?: string };

export interface ContactFilters {
  search?: string;
  listId?: string;
  status?: IContact['status'];
  delivery?: 'delivered' | 'never' | 'undeliverable';
  /** Situação da verificação de caixa postal; `unverified` = nunca verificado. */
  verification?: VerificationStatus | 'unverified';
  page?: number;
  limit?: number;
}

export interface ContactListResult {
  contacts: IContact[];
  total: number;
  page: number;
  limit: number;
}

export interface ValidatedRow {
  email: string;
  name?: string;
  phone?: string;
  company?: string;
  metadata?: Record<string, string>;
  /** Domínio descartável: o contato entra sinalizado (`risky`). Ausente em arquivos antigos. */
  disposable?: boolean;
  /** Domínio com possível erro de digitação: o domínio sugerido. Ausente em arquivos antigos. */
  typoSuggestion?: string;
}

/**
 * - new        → email novo e válido
 * - add-to-list → já cadastrado, fora da lista de destino
 * - in-list     → já cadastrado e já na lista de destino (ignorado)
 * - already     → já cadastrado, sem lista de destino escolhida (ignorado)
 * - invalid     → formato, domínio inexistente ou repetido no arquivo
 */
export type RowKind = 'new' | 'add-to-list' | 'in-list' | 'already' | 'invalid';

export interface ClassifiedRow extends Required<Omit<ValidatedRow, 'disposable' | 'typoSuggestion'>> {
  kind: RowKind;
  reason?: string;
  disposable?: boolean;
  typoSuggestion?: string;
}

/**
 * Estado que atravessa os lotes de uma validação. `seen` é a única estrutura que cresce
 * com o arquivo (~100 MB de heap por milhão de emails) e limita o tamanho da importação.
 * `domains` evita ir ao Redis a cada linha do mesmo domínio.
 */
export interface ClassifyContext {
  domains: Map<string, DomainVerdict>;
  seen: Set<string>;
  /** Contexto do detector de erro de digitação, carregado uma vez por arquivo. */
  typo?: Required<TypoContext>;
  /** Sugestão já calculada por domínio (`null` = sem suspeita). */
  typoByDomain?: Map<string, string | null>;
}

const COLUMN_ALIASES = {
  email: ['email', 'e-mail', 'e_mail', 'mail'],
  name: ['name', 'nome', 'nome completo', 'full name'],
  phone: ['phone', 'telefone', 'celular', 'fone', 'mobile', 'whatsapp'],
  company: ['company', 'empresa', 'organização', 'organizacao'],
} as const;

/** Colunas informativas da exportação; ignoradas para que reimportar não as vire metadata. */
const COLUNAS_INFORMATIVAS = ['situacao', 'situação', 'status', 'criado em', 'criado_em', 'created at'];

interface ExistingContact {
  _id: Types.ObjectId;
  email: string;
  lists: Types.ObjectId[];
}

interface NewContactDoc {
  email: string;
  name: string;
  phone: string;
  company: string;
  lists: string[];
  metadata: Record<string, string>;
  verification?: ContactVerification;
}

export class ContactService {
  private async syncListCounts(listIds: (Types.ObjectId | string)[]): Promise<void> {
    const unique = [...new Set(listIds.map((id) => String(id)))];
    await Promise.all(
      unique.map(async (id) => {
        const count = await Contact.countDocuments({ lists: id });
        await List.updateOne({ _id: id }, { contactCount: count });
      })
    );
  }

  private mapRow(row: CsvRow) {
    const out = { email: '', name: '', phone: '', company: '', metadata: {} as Record<string, string> };
    for (const [header, value] of Object.entries(row)) {
      if (COLUMN_ALIASES.email.includes(header as never)) out.email = value.toLowerCase().trim();
      else if (COLUMN_ALIASES.name.includes(header as never)) out.name = value;
      else if (COLUMN_ALIASES.phone.includes(header as never)) out.phone = value;
      else if (COLUMN_ALIASES.company.includes(header as never)) out.company = value;
      else if (value && !COLUNAS_INFORMATIVAS.includes(header)) out.metadata[header] = value;
    }
    return out;
  }

  async list(filters: ContactFilters = {}): Promise<ContactListResult> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(200, Math.max(1, filters.limit ?? 50));

    const query: Record<string, unknown> = {};
    if (filters.search) {
      const rx = escapeRegex(filters.search);
      query.$or = [
        { email: { $regex: rx, $options: 'i' } },
        { name: { $regex: rx, $options: 'i' } },
        { company: { $regex: rx, $options: 'i' } },
      ];
    }
    if (filters.listId) query.lists = filters.listId;
    if (filters.status) query.status = filters.status;

    if (filters.delivery === 'delivered') query.lastDeliveredAt = { $ne: null };
    else if (filters.delivery === 'never') query.lastDeliveredAt = null;
    else if (filters.delivery === 'undeliverable') query.status = 'bounced';

    if (filters.verification === 'unverified') query.verification = null;
    else if (filters.verification) query['verification.status'] = filters.verification;

    const [contacts, total] = await Promise.all([
      Contact.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<IContact[]>(),
      Contact.countDocuments(query),
    ]);

    // .lean() ignora os getters do schema, então o telefone é decifrado aqui.
    const decrypted = contacts.map((c) => ({ ...c, phone: decrypt(c.phone) }));
    return { contacts: decrypted, total, page, limit };
  }

  async getById(id: string): Promise<ContactDocument> {
    const contact = await Contact.findById(id);
    if (!contact) throw new NotFoundError('Contato não encontrado.');
    return contact;
  }

  /**
   * Cadastro avulso: o domínio (DNS e checagem de descartável) e, com a verificação ligada,
   * a caixa postal. Sem veredito do provedor o contato entra mesmo assim, sem verificação.
   */
  private async assertCanReceiveMail(email: string, keepEmail = false): Promise<ContactVerification | null> {
    // Suspeito de erro de digitação entra marcado, sem gastar consulta com um endereço errado.
    const suggestion = keepEmail ? null : await emailTypoService.suggestionFor(email);
    if (suggestion) return typoVerification(suggestion);

    const domain = await domainCheck.checkEmail(email, { waitForSlotMs: INTERACTIVE_DOMAIN_WAIT_MS });
    if (domain === 'no-mail') {
      throw new ValidationError([
        { field: 'email', message: 'O domínio deste email não existe ou não recebe mensagens.' },
      ]);
    }
    // A caixa postal daria `disposable` de novo: não gasta o crédito.
    if (domain === 'disposable') return disposableDomainVerification();

    const verification = await emailVerificationService.verifySingle(email);
    if (verification?.status === 'undeliverable') {
      throw new ValidationError([
        {
          field: 'email',
          message: `Este email não recebe mensagens: ${emailVerificationService.describe(verification)}.`,
        },
      ]);
    }
    return verification;
  }

  async create(data: CreateContactInput): Promise<ContactDocument> {
    const email = data.email.toLowerCase().trim();
    const existing = await Contact.findOne({ email });
    if (existing) throw new ConflictError('Já existe um contato com este email.');
    const verification = await this.assertCanReceiveMail(email, data.keepEmail);

    const contact = await Contact.create({
      email,
      name: data.name ?? '',
      phone: data.phone ?? '',
      company: data.company ?? '',
      lists: data.lists ?? [],
      status: data.status ?? 'active',
      metadata: data.metadata ?? {},
      ...(verification ? { verification } : {}),
    });

    await this.syncListCounts(contact.lists);
    return contact;
  }

  async update(id: string, data: UpdateContactInput): Promise<ContactDocument> {
    const contact = await this.getById(id);
    const previousLists = [...contact.lists];

    if (data.email !== undefined) {
      const normalized = data.email.toLowerCase().trim();
      if (normalized !== contact.email) {
        const clash = await Contact.findOne({ email: normalized });
        if (clash) throw new ConflictError('Já existe um contato com este email.');
        // Email novo: a verificação do endereço antigo não vale mais.
        contact.verification = (await this.assertCanReceiveMail(normalized, data.keepEmail)) ?? undefined;
      }
      contact.email = normalized;
    }
    if (data.name !== undefined) contact.name = data.name;
    if (data.phone !== undefined) contact.phone = data.phone;
    if (data.company !== undefined) contact.company = data.company;
    if (data.lists !== undefined) contact.lists = data.lists.map((l) => new Types.ObjectId(l));
    if (data.metadata !== undefined) contact.metadata = new Map(Object.entries(data.metadata));

    if (data.status !== undefined) {
      contact.status = data.status;
      contact.unsubscribedAt = data.status === 'unsubscribed' ? new Date() : null;
    }

    await contact.save();
    await this.syncListCounts([...previousLists, ...contact.lists]);
    return contact;
  }

  async reactivate(id: string): Promise<ContactDocument> {
    const contact = await this.getById(id);
    contact.status = 'active';
    contact.unsubscribedAt = null;
    await contact.save();
    return contact;
  }

  async save(data: SaveContactInput): Promise<ContactDocument> {
    if (data.id) return this.update(data.id, data);
    return this.create(data);
  }

  async remove(id: string): Promise<void> {
    const contact = await this.getById(id);
    const lists = [...contact.lists];
    await contact.deleteOne();
    await this.syncListCounts(lists);
  }

  async bulkDelete(ids: string[]): Promise<{ deleted: number }> {
    const contacts = await Contact.find({ _id: { $in: ids } })
      .select('lists')
      .lean<{ lists: Types.ObjectId[] }[]>();
    const affected = contacts.flatMap((c) => c.lists);

    const result = await Contact.deleteMany({ _id: { $in: ids } });
    await this.syncListCounts(affected);
    return { deleted: result.deletedCount ?? 0 };
  }

  private async findExistingByEmail(emails: string[]): Promise<Map<string, ExistingContact>> {
    if (!emails.length) return new Map();
    const docs = await Contact.find({ email: { $in: emails } })
      .select('email lists')
      .lean<ExistingContact[]>();
    return new Map(docs.map((d) => [d.email, d]));
  }

  /** Só emails novos gastam consulta: quem já está na base não tem o domínio rechecado. */
  private async warmDomainCache(emails: string[], cache: Map<string, DomainVerdict>): Promise<void> {
    const pending = [...new Set(emails.map(domainOf).filter(Boolean))].filter((d) => !cache.has(d));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const domain = pending[next++];
        cache.set(domain, await domainCheck.check(domain, { waitForSlotMs: IMPORT_DOMAIN_WAIT_MS }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMPORT_DOMAIN_CONCURRENCY, pending.length) }, worker));
  }

  private async domainVerdict(email: string, cache: Map<string, DomainVerdict>): Promise<DomainVerdict> {
    const domain = domainOf(email);
    const known = cache.get(domain);
    if (known) return known;
    const verdict = await domainCheck.check(domain, { waitForSlotMs: IMPORT_DOMAIN_WAIT_MS });
    cache.set(domain, verdict);
    return verdict;
  }

  /**
   * `bulkWrite` não passa pelos hooks do tenantScope, então o filtro por cliente entra
   * à mão, como defesa em profundidade.
   */
  private async linkToLists(ops: AnyBulkWriteOperation[]): Promise<void> {
    if (!ops.length) return;
    const tenantId = requireTenantId();
    const scoped = tenantId
      ? ops.map((op) => {
          const update = (op as { updateOne?: { filter: Record<string, unknown> } }).updateOne;
          if (update) update.filter = { ...update.filter, tenantId };
          return op;
        })
      : ops;
    await Contact.bulkWrite(scoped, { ordered: false });
  }

  /**
   * `insertMany` aplica os setters do schema (o telefone é cifrado), por isso não vira
   * bulkWrite. Se houver corrida no mesmo email, refaz linha a linha para separar os
   * duplicados.
   */
  private async insertNew(docs: NewContactDoc[]): Promise<{ inserted: number; duplicates: string[] }> {
    if (!docs.length) return { inserted: 0, duplicates: [] };
    try {
      const created = await Contact.insertMany(docs, { ordered: false });
      return { inserted: created.length, duplicates: [] };
    } catch {
      let inserted = 0;
      const duplicates: string[] = [];
      for (const doc of docs) {
        try {
          await Contact.create(doc);
          inserted++;
        } catch (err) {
          if ((err as { code?: number }).code === 11000) duplicates.push(doc.email);
          else throw err;
        }
      }
      return { inserted, duplicates };
    }
  }

  /**
   * Sugestão de domínio por email, com o contexto do cliente carregado uma vez por arquivo
   * e o resultado guardado por domínio (a base tem poucos domínios e muitas linhas).
   */
  private async typoLookup(ctx: ClassifyContext): Promise<(email: string) => string | null> {
    ctx.typo ??= await emailTypoService.context();
    ctx.typoByDomain ??= new Map();
    const typo = ctx.typo;
    const memo = ctx.typoByDomain;
    return (email: string) => {
      const domain = domainOf(email);
      if (!memo.has(domain)) memo.set(domain, suggestDomain(domain, typo));
      return memo.get(domain) ?? null;
    };
  }

  /** Classifica um lote sem gravar; `ctx` acumula o cache de DNS e os emails já vistos. */
  async classifyBatch(rows: CsvRow[], listIds: string[], ctx: ClassifyContext): Promise<ClassifiedRow[]> {
    const mapped = rows.map((r) => this.mapRow(r));

    const lookup = mapped.map((m) => m.email).filter((e) => e && EMAIL_RE.test(e));
    const existing = await this.findExistingByEmail(lookup);
    const typoOf = await this.typoLookup(ctx);
    // Suspeito de erro de digitação não gasta consulta: o domínio está errado.
    await this.warmDomainCache(
      lookup.filter((e) => !existing.has(e) && !typoOf(e)),
      ctx.domains
    );

    const out: ClassifiedRow[] = [];

    for (const fields of mapped) {
      const email = fields.email;
      let kind: RowKind;
      let reason: string | undefined;
      let disposable = false;
      let typoSuggestion: string | null = null;

      if (!email || !EMAIL_RE.test(email)) {
        kind = 'invalid';
        reason = 'Formato inválido';
      } else if (ctx.seen.has(email)) {
        kind = 'invalid';
        reason = 'Repetido no arquivo';
      } else {
        ctx.seen.add(email);
        const found = existing.get(email);

        if (found) {
          if (!listIds.length) {
            kind = 'already';
          } else {
            const current = new Set(found.lists.map(String));
            kind = listIds.some((l) => !current.has(l)) ? 'add-to-list' : 'in-list';
          }
        } else {
          typoSuggestion = typoOf(email);
          const verdict = typoSuggestion ? null : await this.domainVerdict(email, ctx.domains);
          if (typoSuggestion) {
            kind = 'new';
            reason = `Possível erro de digitação: o certo deve ser @${typoSuggestion}`;
          } else if (verdict === 'no-mail') {
            kind = 'invalid';
            reason = 'Domínio inexistente';
          } else {
            kind = 'new';
            disposable = verdict === 'disposable';
          }
        }
      }

      out.push({
        ...fields,
        email: email || '',
        kind,
        reason,
        ...(disposable ? { disposable } : {}),
        ...(typoSuggestion ? { typoSuggestion } : {}),
      });
    }

    return out;
  }

  /**
   * Grava um lote já classificado. Não recalcula o contador das listas: quem processa o
   * arquivo chama `syncCounts` uma vez no fim.
   */
  async importRows(rows: ValidatedRow[], listIds: string[] = []): Promise<{ imported: number; skipped: number }> {
    const valid = rows
      .map((r) => ({ ...r, email: (r.email || '').toLowerCase().trim() }))
      .filter((r) => r.email && EMAIL_RE.test(r.email));
    let skipped = rows.length - valid.length;
    if (!valid.length) return { imported: 0, skipped };

    const existing = await this.findExistingByEmail(valid.map((r) => r.email));
    const linkOps: AnyBulkWriteOperation[] = [];
    const toInsert: NewContactDoc[] = [];
    let imported = 0;

    for (const r of valid) {
      const found = existing.get(r.email);
      if (found) {
        const current = new Set(found.lists.map(String));
        const toAdd = listIds.filter((l) => !current.has(l));
        if (toAdd.length) {
          linkOps.push({
            updateOne: {
              filter: { _id: found._id },
              update: { $addToSet: { lists: { $each: toAdd.map((id) => new Types.ObjectId(id)) } } },
            },
          });
          imported++;
        } else {
          skipped++;
        }
        continue;
      }
      toInsert.push({
        email: r.email,
        name: r.name ?? '',
        phone: r.phone ?? '',
        company: r.company ?? '',
        lists: listIds,
        metadata: r.metadata ?? {},
        ...this.importedVerification(r),
      });
    }

    await this.linkToLists(linkOps);
    const { inserted, duplicates } = await this.insertNew(toInsert);
    return { imported: imported + inserted, skipped: skipped + duplicates.length };
  }

  private importedVerification(row: ValidatedRow): { verification?: ContactVerification } {
    if (row.typoSuggestion) return { verification: typoVerification(row.typoSuggestion) };
    if (row.disposable) return { verification: disposableDomainVerification() };
    return {};
  }

  async syncCounts(listIds: (Types.ObjectId | string)[]): Promise<void> {
    await this.syncListCounts(listIds);
  }
}

export default new ContactService();
