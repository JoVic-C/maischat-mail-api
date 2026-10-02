import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export type FormSubmissionStatus = 'queued' | 'sent' | 'failed' | 'rejected';

export interface IFormSubmission {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  webhookId: Types.ObjectId;
  email: string;
  name: string;
  status: FormSubmissionStatus;
  reason: string;
  fields: Record<string, string>;
  ip: string;
  messageId: string;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FormSubmissionDocument = HydratedDocument<IFormSubmission>;

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

const formSubmissionSchema = new Schema<IFormSubmission>(
  {
    webhookId: { type: Schema.Types.ObjectId, ref: 'FormWebhook', required: true },
    email: { type: String, default: '' },
    name: { type: String, default: '' },
    status: { type: String, enum: ['queued', 'sent', 'failed', 'rejected'], default: 'queued' },
    reason: { type: String, default: '' },
    fields: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: '' },
    messageId: { type: String, default: '' },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

formSubmissionSchema.plugin(tenantScope);
formSubmissionSchema.index({ tenantId: 1, webhookId: 1, createdAt: -1 });
formSubmissionSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export default model<IFormSubmission>('FormSubmission', formSubmissionSchema);
