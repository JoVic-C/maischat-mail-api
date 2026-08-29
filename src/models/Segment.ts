import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export type SegmentOperator = 'equals' | 'contains';

export interface ISegmentRule {
  field: string;
  operator: SegmentOperator;
  value: string;
}

export interface ISegment {
  /** Cliente dono do registro. Preenchido automaticamente pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  name: string;
  rules: ISegmentRule[];
  matchAll: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type SegmentDocument = HydratedDocument<ISegment>;

const ruleSchema = new Schema<ISegmentRule>(
  {
    field: { type: String, required: true, trim: true },
    operator: { type: String, enum: ['equals', 'contains'], default: 'equals' },
    value: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const segmentSchema = new Schema<ISegment>(
  {
    name: { type: String, required: true, trim: true, index: true },
    rules: { type: [ruleSchema], default: [] },
    matchAll: { type: Boolean, default: true },
  },
  { timestamps: true }
);

segmentSchema.plugin(tenantScope);

export default model<ISegment>('Segment', segmentSchema);
