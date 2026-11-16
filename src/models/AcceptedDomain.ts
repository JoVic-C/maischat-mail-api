import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

/**
 * Domínio que o detector de erro de digitação apontou e o admin do cliente revisou e
 * decidiu manter (ex.: `cloud.com` é real, não é `icloud.com`). Deixa de ser suspeito
 * só para este cliente.
 */
export interface IAcceptedDomain {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  domain: string;
  acceptedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AcceptedDomainDocument = HydratedDocument<IAcceptedDomain>;

const acceptedDomainSchema = new Schema<IAcceptedDomain>(
  {
    domain: { type: String, required: true, lowercase: true, trim: true },
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

acceptedDomainSchema.index({ tenantId: 1, domain: 1 }, { unique: true });

acceptedDomainSchema.plugin(tenantScope);

export default model<IAcceptedDomain>('AcceptedDomain', acceptedDomainSchema);
