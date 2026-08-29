import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export type ListType = 'public' | 'private';

export interface IList {
  /** Cliente dono do registro. Preenchido automaticamente pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  name: string;
  description: string;
  type: ListType;
  tags: string[];
  contactCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ListDocument = HydratedDocument<IList>;

const listSchema = new Schema<IList>(
  {
    name: { type: String, required: true, trim: true, index: true },
    description: { type: String, default: '', trim: true },
    type: { type: String, enum: ['public', 'private'], default: 'private', index: true },
    tags: { type: [String], default: [] },
    contactCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

listSchema.plugin(tenantScope);

export default model<IList>('List', listSchema);
