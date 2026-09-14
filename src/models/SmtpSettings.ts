import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { decrypt, encrypt } from '../utils/fieldCrypto';
import { tenantScope } from './plugins/tenantScope';

export interface ISmtpSettings {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
  isDefault: boolean;
  /** 0 significa sem limite. */
  dailyLimit: number;
  hourlyLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

export type SmtpSettingsDocument = HydratedDocument<ISmtpSettings>;

const smtpSchema = new Schema<ISmtpSettings>(
  {
    name: { type: String, required: true, trim: true },
    host: { type: String, required: true, trim: true },
    port: { type: Number, required: true, default: 587 },
    secure: { type: Boolean, default: false },
    user: { type: String, required: true, trim: true },
    password: { type: String, required: true, set: encrypt, get: decrypt },
    fromName: { type: String, required: true, trim: true },
    fromEmail: { type: String, required: true, trim: true, lowercase: true },
    isDefault: { type: Boolean, default: false, index: true },
    dailyLimit: { type: Number, default: 0, min: 0 },
    hourlyLimit: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

smtpSchema.plugin(tenantScope);

export default model<ISmtpSettings>('SmtpSettings', smtpSchema);
