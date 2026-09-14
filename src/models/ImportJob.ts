/**
 * Estado de uma importação de contatos. Fica no banco, e não em memória: a validação dura
 * minutos, a tela precisa reencontrar o job após um F5 e a confirmação vem em outra requisição.
 */
import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export type ImportJobStatus =
  | 'uploaded'
  | 'validating'
  | 'validated' // aguardando a confirmação do usuário
  | 'importing'
  | 'done'
  | 'failed'
  | 'canceled';

export interface ImportCounters {
  rows: number;
  new: number;
  addToList: number;
  inList: number;
  already: number;
  invalid: number;
}

export interface ImportSampleRow {
  email: string;
  kind: string;
  reason?: string;
}

export interface IImportJob {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  createdBy: Types.ObjectId;
  originalName: string;
  sizeBytes: number;
  sourcePath: string;
  validPath: string;
  invalidPath: string;
  /** Mudar a lista depois da validação exige revalidar. */
  listIds: Types.ObjectId[];
  status: ImportJobStatus;
  counters: ImportCounters;
  imported: number;
  skipped: number;
  sample: ImportSampleRow[];
  error: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ImportJobDocument = HydratedDocument<IImportJob>;

const countersSchema = new Schema<ImportCounters>(
  {
    rows: { type: Number, default: 0 },
    new: { type: Number, default: 0 },
    addToList: { type: Number, default: 0 },
    inList: { type: Number, default: 0 },
    already: { type: Number, default: 0 },
    invalid: { type: Number, default: 0 },
  },
  { _id: false }
);

const importJobSchema = new Schema<IImportJob>(
  {
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    originalName: { type: String, default: '' },
    sizeBytes: { type: Number, default: 0 },
    sourcePath: { type: String, required: true },
    validPath: { type: String, default: '' },
    invalidPath: { type: String, default: '' },
    listIds: { type: [Schema.Types.ObjectId], ref: 'List', default: [] },
    status: {
      type: String,
      enum: ['uploaded', 'validating', 'validated', 'importing', 'done', 'failed', 'canceled'],
      default: 'uploaded',
      index: true,
    },
    counters: { type: countersSchema, default: () => ({}) },
    imported: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    sample: { type: [new Schema({ email: String, kind: String, reason: String }, { _id: false })], default: [] },
    error: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

// A limpeza é um job, não índice TTL: o TTL apagaria o documento e deixaria o arquivo órfão no disco.
importJobSchema.plugin(tenantScope);

export default model<IImportJob>('ImportJob', importJobSchema);
