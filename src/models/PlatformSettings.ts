import { type HydratedDocument, model, Schema } from 'mongoose';

/**
 * Ajustes da plataforma, acima dos clientes (sem o plugin tenantScope). Documento único:
 * o índice único em `key` garante que criações simultâneas não dupliquem.
 */
export interface IPlatformSettings {
  key: string;
  /** Recurso compartilhado por todos os clientes. */
  workerConcurrency: number;
  ratePerMinute: number;
  updatedByEmail: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PlatformSettingsDocument = HydratedDocument<IPlatformSettings>;

export const SINGLETON_KEY = 'singleton';

/**
 * Um valor absurdo derruba a plataforma inteira: concorrência alta estoura o event loop e
 * as conexões do Mongo; taxa alta queima a reputação do domínio.
 */
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 50;
export const RATE_PER_MINUTE_MIN = 1;
export const RATE_PER_MINUTE_MAX = 100_000;

const platformSettingsSchema = new Schema<IPlatformSettings>(
  {
    key: { type: String, required: true, unique: true, default: SINGLETON_KEY },
    workerConcurrency: {
      type: Number,
      required: true,
      min: CONCURRENCY_MIN,
      max: CONCURRENCY_MAX,
    },
    ratePerMinute: {
      type: Number,
      required: true,
      min: RATE_PER_MINUTE_MIN,
      max: RATE_PER_MINUTE_MAX,
    },
    updatedByEmail: { type: String, default: '' },
  },
  { timestamps: true }
);

export default model<IPlatformSettings>('PlatformSettings', platformSettingsSchema);
