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

/** Uma linha do CSV depois de classificada, pronta para ser gravada ou recusada. */
export interface ClassifiedRow extends Required<ValidatedRow> {
  kind: RowKind;
  reason?: string;
}

/**
 * Estado que atravessa os lotes de uma mesma validação.
 * - mxCache → domínios já resolvidos; sem ele o mesmo domínio seria consultado a
 *   cada lote, e uma lista real repete pouquíssimos domínios milhares de vezes.
 * - seen    → emails já vistos NESTE arquivo; é o que detecta linha repetida.
 *
 * `seen` é a única estrutura que cresce com o tamanho do arquivo: medido, custa
 * ~100 MB de heap para 1 milhão de emails. É o teto prático de uma importação, e a
 * razão de a concorrência do worker de importação ser baixa.
 */
export interface ClassifyContext {
  mxCache: Map<string, boolean>;
  seen: Set<string>;
}

/** Colunas reconhecidas em PT e EN — o resto vira metadata. */
const COLUMN_ALIASES = {
  email: ['email', 'e-mail', 'e_mail', 'mail'],
  name: ['name', 'nome', 'nome completo', 'full name'],
  phone: ['phone', 'telefone', 'celular', 'fone', 'mobile', 'whatsapp'],
  company: ['company', 'empresa', 'organização', 'organizacao'],
} as const;

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

  /**
   * Classifica um lote de linhas do CSV sem gravar nada.
   *
   * É o núcleo da validação, extraído para ser chamado em sequência sobre um arquivo
   * grande: o chamador controla o laço e o que faz com o resultado, então nada além
   * do lote corrente fica em memória. `ctx` atravessa os lotes porque as duas
   * estruturas são cumulativas — o cache de DNS evita reconsultar o mesmo domínio, e
   * `seen` é o que detecta email repetido DENTRO do arquivo.
   */
  async classifyBatch(rows: CsvRow[], listIds: string[], ctx: ClassifyContext): Promise<ClassifiedRow[]> {
    const mapped = rows.map((r) => this.mapRow(r));

    // Uma query de existência e uma rodada de DNS para o lote inteiro, em vez de
    // uma por linha. Só emails com formato válido entram na consulta.
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
          // Já cadastrado: a classificação depende da lista de destino escolhida.
          if (!listIds.length) {
            kind = 'already';
          } else {
            const current = new Set(found.lists.map(String));
            kind = listIds.some((l) => !current.has(l)) ? 'add-to-list' : 'in-list';
          }
        } else if (!(await domainHasMail(email.split('@')[1] ?? '', ctx.mxCache))) {
          // O warmDomainCache já resolveu os domínios do lote, então isto é sempre
          // acerto de cache — mas passa pelo helper para a regra não depender de um
          // efeito colateral.
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
   * Grava um lote de linhas JÁ classificadas: cria as novas e vincula as existentes
   * às listas de destino, sem sobrescrever dados.
   *
   * NÃO recalcula o contador das listas — quem processa um arquivo inteiro chama
   * `syncCounts` uma vez no fim, em vez de uma contagem completa por lote.
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
          imported++; // vinculado à(s) nova(s) lista(s)
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
    // Corrida: mesmo email inserido concorrentemente → conta como pulado, sem abortar.
    const { inserted, duplicates } = await this.insertNew(toInsert);
    return { imported: imported + inserted, skipped: skipped + duplicates.length };
  }

  /** Recalcula o contactCount das listas. Chamar uma vez ao fim de uma importação. */
  async syncCounts(listIds: (Types.ObjectId | string)[]): Promise<void> {
    await this.syncListCounts(listIds);
  }
}

export default new ContactService();
