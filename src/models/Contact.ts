import { type HydratedDocument, model, Schema, type Types } from 'mongoose';
import { decrypt, encrypt } from '../utils/fieldCrypto';
import { tenantScope } from './plugins/tenantScope';

export type ContactStatus = 'active' | 'unsubscribed' | 'bounced';

export interface IContact {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  email: string;
  name: string;
  phone: string;
  company: string;
  lists: Types.ObjectId[];
  status: ContactStatus;
  unsubscribedAt: Date | null;
  /** Último envio aceito com sucesso. */
  lastDeliveredAt: Date | null;
  metadata: Map<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export type ContactDocument = HydratedDocument<IContact>;

const contactSchema = new Schema<IContact>(
  {
    // Único por cliente (índice composto abaixo).
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true, set: encrypt, get: decrypt },
    company: { type: String, default: '', trim: true, index: true },
    lists: [{ type: Schema.Types.ObjectId, ref: 'List', index: true }],
    status: { type: String, enum: ['active', 'unsubscribed', 'bounced'], default: 'active', index: true },
    unsubscribedAt: { type: Date, default: null },
    lastDeliveredAt: { type: Date, default: null, index: true },
    metadata: { type: Map, of: String, default: {} },
  },
  { timestamps: true, toJSON: { getters: true }, toObject: { getters: true } }
);

contactSchema.index({ tenantId: 1, email: 1 }, { unique: true });
contactSchema.index({ tenantId: 1, lists: 1 });
contactSchema.index({ tenantId: 1, status: 1 });

contactSchema.plugin(tenantScope);

export default model<IContact>('Contact', contactSchema);
