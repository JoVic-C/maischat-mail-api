import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export type CheckState = 'pass' | 'fail' | 'error';
export type SendingDomainStatus = 'verified' | 'unverified';

export interface CheckResult {
  state: CheckState;
  detail: string;
}

export interface DomainChecks {
  spf: CheckResult;
  dkim: CheckResult;
  dmarc: CheckResult;
}

export interface ISendingDomain {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  domain: string;
  status: SendingDomainStatus;
  checks: DomainChecks | null;
  checkedAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SendingDomainDocument = HydratedDocument<ISendingDomain>;

const checkSchema = new Schema<CheckResult>(
  {
    state: { type: String, enum: ['pass', 'fail', 'error'], required: true },
    detail: { type: String, default: '' },
  },
  { _id: false }
);

const checksSchema = new Schema<DomainChecks>(
  { spf: checkSchema, dkim: checkSchema, dmarc: checkSchema },
  { _id: false }
);

const sendingDomainSchema = new Schema<ISendingDomain>(
  {
    domain: { type: String, required: true, trim: true, lowercase: true },
    status: { type: String, enum: ['verified', 'unverified'], default: 'unverified' },
    checks: { type: checksSchema, default: null },
    checkedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

sendingDomainSchema.plugin(tenantScope);
sendingDomainSchema.index({ tenantId: 1, domain: 1 }, { unique: true });

export default model<ISendingDomain>('SendingDomain', sendingDomainSchema);
