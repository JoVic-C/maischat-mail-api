import { type AnyBulkWriteOperation, Types } from 'mongoose';
import { requireTenantId } from '../config/tenantContext';
import { ConflictError, NotFoundError } from '../errors';
import Contact, { type ContactDocument, type IContact } from '../models/Contact';
import List from '../models/List';
import type { CsvRow } from '../utils/csv';
import { domainHasMail, EMAIL_RE } from '../utils/emailHygiene';
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
  delivery?: 'delivered' | 'never' | 'undeliverable';
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
}

/**
 * - new         → email novo e válido
 * - add-to-list → já cadastrado, fora da lista de destino
 * - in-list     → já cadastrado e já na lista de destino (ignorado)
 * - already     → já cadastrado, sem lista de destino escolhida (ignorado)
 * - invalid     → formato, domínio inexistente ou repetido no arquivo
 */
export type RowKind = 'new' | 'add-to-list' | 'in-list' | 'already' | 'invalid';

export interface ClassifiedRow extends Required<ValidatedRow> {
  kind: RowKind;
  reason?: string;
}

/**
 * Estado que atravessa os lotes de uma validação. `seen` é a única estrutura que cresce
 * com o arquivo (~100 MB de heap por milhão de emails) e limita o tamanho da importação.
 */
export interface ClassifyContext {
  mxCache: Map<string, boolean>;
  seen: Set<string>;
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

  private async warmDomainCache(emails: string[], cache: Map<string, boolean>): Promise<void> {
    const domains = [...new Set(emails.map((e) => e.split('@')[1]?.toLowerCase()).filter(Boolean))].filter(
      (d) => !cache.has(d)
    );
    await Promise.all(domains.map((d) => domainHasMail(d, cache)));
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

  /** Classifica um lote sem gravar; `ctx` acumula o cache de DNS e os emails já vistos. */
  async classifyBatch(rows: CsvRow[], listIds: string[], ctx: ClassifyContext): Promise<ClassifiedRow[]> {
    const mapped = rows.map((r) => this.mapRow(r));

    const lookup = mapped.map((m) => m.email).filter((e) => e && EMAIL_RE.test(e));
    const [existing] = await Promise.all([this.findExistingByEmail(lookup), this.warmDomainCache(lookup, ctx.mxCache)]);

    const out: ClassifiedRow[] = [];

    for (const fields of mapped) {
      const email = fields.email;
      let kind: RowKind;
      let reason: string | undefined;

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
        } else if (!(await domainHasMail(email.split('@')[1] ?? '', ctx.mxCache))) {
          kind = 'invalid';
          reason = 'Domínio inexistente';
        } else {
          kind = 'new';
        }
      }

      out.push({ ...fields, email: email || '', kind, reason });
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
      });
    }

    await this.linkToLists(linkOps);
    const { inserted, duplicates } = await this.insertNew(toInsert);
    return { imported: imported + inserted, skipped: skipped + duplicates.length };
  }

  async syncCounts(listIds: (Types.ObjectId | string)[]): Promise<void> {
    await this.syncListCounts(listIds);
  }
}

export default new ContactService();
