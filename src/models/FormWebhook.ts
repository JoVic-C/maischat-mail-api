import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { decrypt, encrypt } from '../utils/fieldCrypto';
import { tenantScope } from './plugins/tenantScope';

export interface FormWebhookStats {
  received: number;
  sent: number;
  failed: number;
  rejected: number;
}

export interface IFormWebhook {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  name: string;
  templateId: Types.ObjectId;
  smtpId: Types.ObjectId | null;
  emailField: string;
  nameField: string;
  hourlyLimit: number;
  redirectUrl: string;
  isActive: boolean;
  /** Cifrado, para o painel conseguir mostrar a URL de novo. */
  token: string;
  /** A URL pública é resolvida pelo hash, sem decifrar tokens. */
  tokenHash: string;
  stats: FormWebhookStats;
  lastReceivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FormWebhookDocument = HydratedDocument<IFormWebhook>;

const formWebhookSchema = new Schema<IFormWebhook>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template', required: true },
    smtpId: { type: Schema.Types.ObjectId, ref: 'SmtpSettings', default: null },
    emailField: { type: String, default: '', trim: true, maxlength: 100 },
    nameField: { type: String, default: '', trim: true, maxlength: 100 },
    hourlyLimit: { type: Number, default: 100, min: 1, max: 5000 },
    redirectUrl: { type: String, default: '', trim: true, maxlength: 500 },
    isActive: { type: Boolean, default: true },
    token: { type: String, required: true, set: encrypt, get: decrypt },
    tokenHash: { type: String, required: true, index: true },
    stats: {
      received: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
    },
    lastReceivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

formWebhookSchema.plugin(tenantScope);
formWebhookSchema.index({ tenantId: 1, tokenHash: 1 }, { unique: true });
formWebhookSchema.index({ tenantId: 1, createdAt: -1 });

export default model<IFormWebhook>('FormWebhook', formWebhookSchema);
