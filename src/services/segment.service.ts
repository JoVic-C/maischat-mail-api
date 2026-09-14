import { NotFoundError } from '../errors';
import Contact from '../models/Contact';
import Segment, { type ISegment, type ISegmentRule, type SegmentDocument } from '../models/Segment';
import { escapeRegex } from '../utils/regex';

export interface SaveSegmentInput {
  id?: string;
  name: string;
  rules: ISegmentRule[];
  matchAll?: boolean;
}

/** Campos que uma regra pode filtrar; os demais são ignorados. */
const ALLOWED_FIELDS = ['company', 'status', 'name', 'email'];

export class SegmentService {
  private ruleToQuery(rule: ISegmentRule): Record<string, unknown> {
    const isMetadata = rule.field.startsWith('metadata.');
    if (!isMetadata && !ALLOWED_FIELDS.includes(rule.field)) {
      return {};
    }
    if (rule.operator === 'contains') {
      return { [rule.field]: { $regex: escapeRegex(rule.value), $options: 'i' } };
    }
    return { [rule.field]: rule.value };
  }

  buildQuery(segment: Pick<ISegment, 'rules' | 'matchAll'>): Record<string, unknown> {
    const fragments = segment.rules.map((r) => this.ruleToQuery(r)).filter((f) => Object.keys(f).length);
    if (!fragments.length) return {};
    return segment.matchAll ? { $and: fragments } : { $or: fragments };
  }

  async list(): Promise<ISegment[]> {
    return Segment.find().sort({ createdAt: -1 }).lean();
  }

  async getById(id: string): Promise<SegmentDocument> {
    const segment = await Segment.findById(id);
    if (!segment) throw new NotFoundError('Segmento não encontrado.');
    return segment;
  }

  async save(data: SaveSegmentInput): Promise<SegmentDocument> {
    if (data.id) {
      const segment = await this.getById(data.id);
      segment.name = data.name;
      segment.rules = data.rules;
      segment.matchAll = data.matchAll ?? true;
      return segment.save();
    }
    return Segment.create({ name: data.name, rules: data.rules, matchAll: data.matchAll ?? true });
  }

  async remove(id: string): Promise<void> {
    const segment = await this.getById(id);
    await segment.deleteOne();
  }

  async preview(id: string): Promise<{ count: number }> {
    const segment = await this.getById(id);
    const query = this.buildQuery(segment);
    const count = await Contact.countDocuments({ ...query, status: 'active' });
    return { count };
  }
}

export default new SegmentService();
