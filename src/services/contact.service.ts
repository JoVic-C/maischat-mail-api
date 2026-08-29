import { type AnyBulkWriteOperation, Types } from 'mongoose';
import { requireTenantId } from '../config/tenantContext';
import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import Contact, { type ContactDocument, type IContact } from '../models/Contact';
import List from '../models/List';
import { type CsvRow, parseCsv } from '../utils/csv';
import { domainHasMail, EMAIL_RE } from '../utils/emailHygiene';
import type { InvalidRow } from '../utils/excel';
import { decrypt } from '../utils/fieldCrypto';
import { escapeRegex } from '../utils/regex';

export interface CreateContactInput {
  email: string;
  name?: string;
  phone?: string;
  company?: string;
  lists?: string[];
  status?: IContact['status'];
  metadata?: Record<string, string>;
}

export type UpdateContactInput = Partial<CreateContactInput>;
export type SaveContactInput = CreateContactInput & { id?: string };

export interface ContactFilters {
  search?: string;
  listId?: string;
  status?: IContact['status'];
  delivery?: 'delivered' | 'never' | 'undeliverable'; // filtro por entrega
  page?: number;
  limit?: number;
}

export interface ContactListResult {
  contacts: IContact[];
  total: number;
  page: number;
  limit: number;
}

export interface ImportResult {
  imported: number; // criados (corretos)
  invalid: InvalidRow[]; // incorretos: formato, domínio, duplicado
  total: number;
}

export interface ValidatedRow {
  email: string;
  name?: string;
  phone?: string;
  company?: string;
  metadata?: Record<string, string>;
}

/**
 * Classificação de cada linha na validação:
 * - new         → email novo e válido (será criado)
 * - add-to-list → já cadastrado, mas não está na lista de destino (será adicionado)
 * - in-list     → já cadastrado e já está na lista de destino (ignorado)
 * - already     → já cadastrado e nenhuma lista de destino foi escolhida (ignorado)
 * - invalid     → formato, domínio inexistente ou duplicado no próprio CSV (erro)
 */
export type RowKind = 'new' | 'add-to-list' | 'in-list' | 'already' | 'invalid';

/** Eventos emitidos durante a validação em streaming (SSE). */
export type ValidateStreamEvent =
  | { type: 'start'; total: number }
  | {
      type: 'row';
      index: number;
      email: string;
      name: string;
      phone: string;
      company: string;
      metadata: Record<string, string>;
      kind: RowKind;
      reason?: string;
    }
  | { type: 'done'; total: number };

/** Colunas reconhecidas em PT e EN — o resto vira metadata. */
const COLUMN_ALIASES = {
  email: ['email', 'e-mail', 'e_mail', 'mail'],
  name: ['name', 'nome', 'nome completo', 'full name'],
  phone: ['phone', 'telefone', 'celular', 'fone', 'mobile', 'whatsapp'],
  company: ['company', 'empresa', 'organização', 'organizacao'],
} as const;

/** Quantas linhas do CSV são resolvidas por rodada (1 query de existência + 1 rodada de DNS). */
const IMPORT_CHUNK = 200;

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
}

export class ContactService {
  /** Recalcula o contactCount das listas afetadas. Chamado sempre que um vínculo muda. */
  private async syncListCounts(listIds: (Types.ObjectId | string)[]): Promise<void> {
    const unique = [...new Set(listIds.map((id) => String(id)))];
    await Promise.all(
      unique.map(async (id) => {
        const count = await Contact.countDocuments({ lists: id });
        await List.updateOne({ _id: id }, { contactCount: count });
      })
    );
  }

  /** Classifica as colunas da linha: conhecidas viram campos, o resto vira metadata. */
  private mapRow(row: CsvRow) {
    const out = { email: '', name: '', phone: '', company: '', metadata: {} as Record<string, string> };
    for (const [header, value] of Object.entries(row)) {
      if (COLUMN_ALIASES.email.includes(header as never)) out.email = value.toLowerCase().trim();
      else if (COLUMN_ALIASES.name.includes(header as never)) out.name = value;
      else if (COLUMN_ALIASES.phone.includes(header as never)) out.phone = value;
      else if (COLUMN_ALIASES.company.includes(header as never)) out.company = value;
      else if (value) out.metadata[header] = value;
    }
    return out;
  }

  /** Listagem paginada com busca por email/nome/empresa e filtros por lista e status. */
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

    // Filtro por entrega: entregues (já receberam), nunca entregaram, ou não-entregáveis (bounce).
    if (filters.delivery === 'delivered') query.lastDeliveredAt = { $ne: null };
    else if (filters.delivery === 'never') query.lastDeliveredAt = null;
    else if (filters.delivery === 'undeliverable') query.status = 'bounced';

    const [contacts, total] = await Promise.all([
      Contact.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<IContact[]>(),
      Contact.countDocuments(query),
    ]);

    // .lean() ignora getters — descriptografa o telefone manualmente.
    const decrypted = contacts.map((c) => ({ ...c, phone: decrypt(c.phone) }));
    return { contacts: decrypted, total, page, limit };
  }

  async getById(id: string): Promise<ContactDocument> {
    const contact = await Contact.findById(id);
    if (!contact) throw new NotFoundError('Contato não encontrado.');
    return contact;
  }

  async create(data: CreateContactInput): Promise<ContactDocument> {
    const email = data.email.toLowerCase().trim();
    const existing = await Contact.findOne({ email });
    if (existing) throw new ConflictError('Já existe um contato com este email.');

    const contact = await Contact.create({
      email,
      name: data.name ?? '',
      phone: data.phone ?? '',
      company: data.company ?? '',
      lists: data.lists ?? [],
      status: data.status ?? 'active',
      metadata: data.metadata ?? {},
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

  /** Reativa um contato bloqueado (bounce/descadastro) — volta para 'active'. */
  async reactivate(id: string): Promise<ContactDocument> {
    const contact = await this.getById(id);
    contact.status = 'active';
    contact.unsubscribedAt = null;
    await contact.save();
    return contact;
  }

  /** Cria quando não há id, atualiza quando há (mesmo padrão de List). */
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

  /** Exclusão em lote (seleção múltipla na tela). */
  async bulkDelete(ids: string[]): Promise<{ deleted: number }> {
    const contacts = await Contact.find({ _id: { $in: ids } })
      .select('lists')
      .lean<{ lists: Types.ObjectId[] }[]>();
    const affected = contacts.flatMap((c) => c.lists);

    const result = await Contact.deleteMany({ _id: { $in: ids } });
    await this.syncListCounts(affected);
    return { deleted: result.deletedCount ?? 0 };
  }

  /** Quebra uma lista em lotes de tamanho fixo. */
  private chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  /** Uma query para descobrir quais emails do lote já existem (em vez de um findOne por linha). */
  private async findExistingByEmail(emails: string[]): Promise<Map<string, ExistingContact>> {
    if (!emails.length) return new Map();
    const docs = await Contact.find({ email: { $in: emails } })
      .select('email lists')
      .lean<ExistingContact[]>();
    return new Map(docs.map((d) => [d.email, d]));
  }

  /** Resolve o DNS de todos os domínios do lote em paralelo (antes era serial, linha a linha). */
  private async warmDomainCache(emails: string[], cache: Map<string, boolean>): Promise<void> {
    const domains = [...new Set(emails.map((e) => e.split('@')[1]?.toLowerCase()).filter(Boolean))].filter(
      (d) => !cache.has(d)
    );
    await Promise.all(domains.map((d) => domainHasMail(d, cache)));
  }

  /**
   * Vincula contatos já existentes às listas de destino, em uma única escrita.
   *
   * `bulkWrite` NÃO passa pelos hooks do plugin tenantScope, então o filtro por
   * cliente entra à mão aqui. Os _id já vieram de uma query escopada; isto é
   * defesa em profundidade para o dia em que alguém mudar a origem dos ids.
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
   * Insere um lote de contatos novos. `insertMany` aplica os setters do schema
   * (o telefone precisa passar pelo encrypt), então NÃO pode virar bulkWrite cru.
   * Em caso de corrida (mesmo email inserido concorrentemente) cai num caminho lento
   * linha a linha só para separar os duplicados do resto.
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

  /** Importa um CSV: cria novos, mescla existentes (sem sobrescrever), vincula às listas. */
  async importCsv(csvContent: string, listIds: string[] = []): Promise<ImportResult> {
    const rows = parseCsv(csvContent);
    if (!rows.length) throw new BadRequestError('CSV vazio ou sem linhas de dados.');

    const result: ImportResult = { imported: 0, invalid: [], total: rows.length };
    const mxCache = new Map<string, boolean>();
    const seen = new Set<string>();

    // Em lotes: por rodada é 1 query de existência + DNS em paralelo + 1 insert em massa,
    // em vez de 1 findOne + 1 DNS + 1 insert POR LINHA.
    for (const rowChunk of this.chunk(rows, IMPORT_CHUNK)) {
      const candidates: ReturnType<typeof this.mapRow>[] = [];

      for (const row of rowChunk) {
        const fields = this.mapRow(row);
        const email = fields.email;

        if (!email || !EMAIL_RE.test(email)) {
          result.invalid.push({ email: email || '(vazio)', name: fields.name, reason: 'Formato inválido' });
          continue;
        }
        if (seen.has(email)) {
          result.invalid.push({ email, name: fields.name, reason: 'Repetido no arquivo' });
          continue;
        }
        seen.add(email);
        candidates.push(fields);
      }
      if (!candidates.length) continue;

      const emails = candidates.map((c) => c.email);
      const [existing] = await Promise.all([this.findExistingByEmail(emails), this.warmDomainCache(emails, mxCache)]);

      const linkOps: AnyBulkWriteOperation[] = [];
      const toInsert: NewContactDoc[] = [];
      const byEmail = new Map(candidates.map((c) => [c.email, c]));

      for (const fields of candidates) {
        const found = existing.get(fields.email);
        if (found) {
          // Já cadastrado: mescla nas listas de destino (sem sobrescrever os dados).
          const current = new Set(found.lists.map(String));
          const toAdd = listIds.filter((l) => !current.has(l));
          if (toAdd.length) {
            linkOps.push({
              updateOne: {
                filter: { _id: found._id },
                update: { $addToSet: { lists: { $each: toAdd.map((id) => new Types.ObjectId(id)) } } },
              },
            });
            result.imported++; // vinculado à(s) nova(s) lista(s)
          }
          continue;
        }

        // O warmDomainCache já resolveu os domínios do lote em paralelo, então esta
        // chamada é sempre um acerto de cache — mas passa pelo helper em vez de ler o
        // Map por fora, o que manteria a regra dependendo de um efeito colateral.
        if (!(await domainHasMail(fields.email.split('@')[1] ?? '', mxCache))) {
          result.invalid.push({ email: fields.email, name: fields.name, reason: 'Domínio inexistente' });
          continue;
        }

        toInsert.push({
          email: fields.email,
          name: fields.name,
          phone: fields.phone,
          company: fields.company,
          lists: listIds,
          metadata: fields.metadata,
        });
      }

      await this.linkToLists(linkOps);
      const { inserted, duplicates } = await this.insertNew(toInsert);
      result.imported += inserted;
      for (const email of duplicates) {
        result.invalid.push({ email, name: byEmail.get(email)?.name ?? '', reason: 'Já cadastrado' });
      }
    }

    await this.syncListCounts(listIds);
    return result;
  }

  /**
   * Valida um CSV em streaming: emite o resultado de cada linha assim que fica pronto.
   * NÃO grava nada — só valida (formato, duplicado, já cadastrado, domínio).
   */
  async validateCsvStream(
    csvContent: string,
    listIds: string[],
    emit: (e: ValidateStreamEvent) => void
  ): Promise<void> {
    const rows = parseCsv(csvContent);
    if (!rows.length) throw new BadRequestError('CSV vazio ou sem linhas de dados.');

    emit({ type: 'start', total: rows.length });

    const mxCache = new Map<string, boolean>();
    const seen = new Set<string>();
    // Prefetch por lote: a existência e o DNS das próximas IMPORT_CHUNK linhas são
    // resolvidos de uma vez, mas os eventos continuam saindo linha a linha, em ordem.
    let existingCache = new Map<string, ExistingContact>();

    for (let i = 0; i < rows.length; i++) {
      if (i % IMPORT_CHUNK === 0) {
        const lookahead = rows
          .slice(i, i + IMPORT_CHUNK)
          .map((r) => this.mapRow(r).email)
          .filter((e) => e && EMAIL_RE.test(e));
        const [found] = await Promise.all([
          this.findExistingByEmail(lookahead),
          this.warmDomainCache(lookahead, mxCache),
        ]);
        existingCache = found;
      }

      const fields = this.mapRow(rows[i]);
      const email = fields.email;
      let kind: RowKind;
      let reason: string | undefined;

      if (!email || !EMAIL_RE.test(email)) {
        kind = 'invalid';
        reason = 'Formato inválido';
      } else if (seen.has(email)) {
        kind = 'invalid';
        reason = 'Repetido no arquivo';
      } else {
        seen.add(email);
        const existing = existingCache.get(email);

        if (existing) {
          // Já cadastrado: a classificação depende da lista de destino escolhida.
          if (!listIds.length) {
            kind = 'already';
          } else {
            const current = new Set(existing.lists.map(String));
            const toAdd = listIds.filter((l) => !current.has(l));
            kind = toAdd.length ? 'add-to-list' : 'in-list';
          }
        } else if (!(await domainHasMail(email.split('@')[1], mxCache))) {
          kind = 'invalid';
          reason = 'Domínio inexistente';
        } else {
          kind = 'new';
        }
      }

      emit({
        type: 'row',
        index: i,
        email: email || '(vazio)',
        name: fields.name,
        phone: fields.phone,
        company: fields.company,
        metadata: fields.metadata,
        kind,
        reason,
      });
    }

    emit({ type: 'done', total: rows.length });
  }

  /**
   * Importa linhas JÁ validadas (sem refazer DNS). Cria novos e mescla os que já existem
   * (vincula às listas sem sobrescrever dados).
   */
  async importValidated(rows: ValidatedRow[], listIds: string[] = []): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;

    for (const rowChunk of this.chunk(rows, IMPORT_CHUNK)) {
      const valid = rowChunk
        .map((r) => ({ ...r, email: (r.email || '').toLowerCase().trim() }))
        .filter((r) => {
          if (!r.email || !EMAIL_RE.test(r.email)) {
            skipped++;
            return false;
          }
          return true;
        });
      if (!valid.length) continue;

      const existing = await this.findExistingByEmail(valid.map((r) => r.email));
      const linkOps: AnyBulkWriteOperation[] = [];
      const toInsert: NewContactDoc[] = [];

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
          }
          skipped++;
          continue;
        }
        toInsert.push({
          email: r.email,
          name: r.name ?? '',
          phone: r.phone ?? '',
          company: r.company ?? '',
          lists: listIds,
          metadata: r.metadata ?? {},
        });
      }

      await this.linkToLists(linkOps);
      // Corrida: mesmo email inserido concorrentemente → conta como pulado, sem abortar.
      const { inserted, duplicates } = await this.insertNew(toInsert);
      imported += inserted;
      skipped += duplicates.length;
    }

    await this.syncListCounts(listIds);
    return { imported, skipped };
  }
}

export default new ContactService();
