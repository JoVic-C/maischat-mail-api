/**
 * Verificação em lote de uma lista na EmailListVerify. O provedor processa a lista de forma
 * assíncrona (minutos a horas), então o estado vive no banco e o worker avança por etapas.
 */
import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export type VerificationJobStatus =
  | 'queued' // aguardando o envio da lista ao provedor
  | 'uploading'
  | 'verifying' // o provedor está verificando
  | 'applying' // gravando os resultados nos contatos
  | 'done'
  | 'failed';

export const ACTIVE_VERIFICATION_STATUSES: VerificationJobStatus[] = ['queued', 'uploading', 'verifying', 'applying'];

export interface VerificationCounters {
  deliverable: number;
  undeliverable: number;
  risky: number;
  unknown: number;
}

export interface IVerificationJob {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  listId: Types.ObjectId;
  createdBy: Types.ObjectId;
  status: VerificationJobStatus;
  /** Verificações reservadas na cota mensal do cliente ao iniciar. */
  reserved: number;
  /** Mês (AAAAMM) da cota reservada, para a devolução cair no mesmo mês. */
  quotaPeriod: string;
  /** Emails efetivamente enviados ao provedor. */
  total: number;
  providerListId: string;
  progress: number;
  counters: VerificationCounters;
  error: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type VerificationJobDocument = HydratedDocument<IVerificationJob>;

const countersSchema = new Schema<VerificationCounters>(
  {
    deliverable: { type: Number, default: 0 },
    undeliverable: { type: Number, default: 0 },
    risky: { type: Number, default: 0 },
    unknown: { type: Number, default: 0 },
  },
  { _id: false }
);

const verificationJobSchema = new Schema<IVerificationJob>(
  {
    listId: { type: Schema.Types.ObjectId, ref: 'List', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['queued', 'uploading', 'verifying', 'applying', 'done', 'failed'],
      default: 'queued',
    },
    reserved: { type: Number, default: 0 },
    quotaPeriod: { type: String, default: '' },
    total: { type: Number, default: 0 },
    providerListId: { type: String, default: '' },
    progress: { type: Number, default: 0 },
    counters: { type: countersSchema, default: () => ({}) },
    error: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

verificationJobSchema.index({ tenantId: 1, listId: 1, createdAt: -1 });

verificationJobSchema.plugin(tenantScope);

export default model<IVerificationJob>('VerificationJob', verificationJobSchema);
