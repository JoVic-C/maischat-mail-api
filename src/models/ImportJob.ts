/**
 * Uma importação de contatos em andamento (ou concluída).
 *
 * O estado vive aqui, e não na memória do processo, por três motivos: a validação
 * de um arquivo grande dura minutos e não pode morrer com a requisição; o painel
 * precisa reencontrar o job depois de um F5; e a confirmação acontece numa
 * requisição diferente da que subiu o arquivo.
 */
import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export type ImportJobStatus =
  | 'uploaded' // arquivo recebido, aguardando o worker
  | 'validating'
  | 'validated' // esperando a confirmação do usuário
  | 'importing'
  | 'done'
  | 'failed'
  | 'canceled';

/** Contadores agregados — é o que a tela mostra, no lugar de um evento por linha. */
export interface ImportCounters {
  rows: number; // linhas de dados lidas até agora
  new: number; // email novo e válido
  addToList: number; // já existe, será vinculado à lista de destino
  inList: number; // já existe e já está na lista
  already: number; // já existe e nenhuma lista foi escolhida
  invalid: number; // formato, domínio inexistente ou repetido no arquivo
}

/** Amostra mostrada na tela durante e depois da validação. */
export interface ImportSampleRow {
  email: string;
  kind: string;
  reason?: string;
}

export interface IImportJob {
  /** Cliente dono do registro. Preenchido automaticamente pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  createdBy: Types.ObjectId;
  originalName: string;
  sizeBytes: number;
  /** Caminhos relativos à raiz do processo. Ficam FORA de uploads/, que é público. */
  sourcePath: string;
  validPath: string;
  invalidPath: string;
  /** Listas de destino escolhidas na validação. Mudar depois exige revalidar. */
  listIds: Types.ObjectId[];
  status: ImportJobStatus;
  counters: ImportCounters;
  imported: number;
  skipped: number;
  sample: ImportSampleRow[];
  error: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Depois disto o job e seus arquivos são apagados pela limpeza periódica. */
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

// A limpeza é um job nosso, não um índice TTL do Mongo: o TTL apagaria o documento
// e deixaria o CSV órfão no disco, sem ninguém que soubesse o caminho dele.
importJobSchema.plugin(tenantScope);

export default model<IImportJob>('ImportJob', importJobSchema);
