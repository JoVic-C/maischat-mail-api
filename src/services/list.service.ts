import { NotFoundError } from '../errors';
import Contact from '../models/Contact';
import List, { type IList, type ListDocument } from '../models/List';
import { escapeRegex } from '../utils/regex';

export interface CreateListInput {
  name: string;
  description?: string;
  type?: IList['type'];
  tags?: string[];
}

export type SaveListInput = CreateListInput & { id?: string };

export type UpdateListInput = Partial<CreateListInput>;

export class ListService {
  async list(search?: string, type?: IList['type']): Promise<IList[]> {
    const query: Record<string, unknown> = {};
    if (search) query.name = { $regex: escapeRegex(search), $options: 'i' };
    if (type) query.type = type;
    return List.find(query).sort({ createdAt: -1 }).lean();
  }

  async getById(id: string): Promise<ListDocument> {
    const list = await List.findById(id);
    if (!list) throw new NotFoundError('Lista não encontrada.');
    return list;
  }

  async create(data: CreateListInput): Promise<ListDocument> {
    return List.create({
      name: data.name,
      description: data.description ?? '',
      type: data.type ?? 'private',
      tags: data.tags ?? [],
    });
  }

  async save(data: SaveListInput): Promise<ListDocument> {
    if (data.id) {
      return this.update(data.id, data);
    }
    return this.create(data);
  }

  async update(id: string, data: UpdateListInput): Promise<ListDocument> {
    const list = await this.getById(id);
    if (data.name !== undefined) list.name = data.name;
    if (data.description !== undefined) list.description = data.description;
    if (data.type !== undefined) list.type = data.type;
    if (data.tags !== undefined) list.tags = data.tags;
    return list.save();
  }

  async remove(id: string): Promise<void> {
    const list = await this.getById(id);
    // Desvincula a lista de todos os contatos (não apaga os contatos, só remove o vínculo)
    await Contact.updateMany({ lists: id }, { $pull: { lists: id } });
    await list.deleteOne();
  }

  /**
   * Recalcula o contactCount de todas as listas a partir dos vínculos reais.
   * Conserta contadores que ficaram dessincronizados (ex.: import interrompido).
   */
  async resyncCounts(): Promise<{ updated: number; total: number }> {
    const lists = await List.find().select('_id contactCount').lean();
    // Uma única agregação conta todos os vínculos por lista (evita N+1).
    const agg = await Contact.aggregate<{ _id: unknown; n: number }>([
      { $unwind: '$lists' },
      { $group: { _id: '$lists', n: { $sum: 1 } } },
    ]);
    const counts = new Map(agg.map((a) => [String(a._id), a.n]));

    const ops = lists
      .filter((l) => (counts.get(String(l._id)) ?? 0) !== l.contactCount)
      .map((l) => ({
        updateOne: {
          filter: { _id: l._id },
          update: { contactCount: counts.get(String(l._id)) ?? 0 },
        },
      }));
    if (ops.length) await List.bulkWrite(ops);
    return { updated: ops.length, total: lists.length };
  }
}

export default new ListService();
