import { type HydratedDocument, model, Schema } from 'mongoose';

/**
 * Ajustes operacionais da plataforma (não de um cliente).
 *
 * Hoje guarda só o que controla o motor de envio. É um documento ÚNICO: o campo `key`
 * tem índice único com valor fixo, então duas instâncias tentando criar ao mesmo tempo
 * resultam em uma criação e um erro de duplicidade — nunca em dois documentos.
 *
 * NÃO leva o plugin `tenantScope`: isto vive acima dos clientes, como o Tenant.
 */
export interface IPlatformSettings {
  /** Discriminador do singleton — sempre 'singleton'. */
  key: string;
  /** Envios simultâneos do worker. Recurso COMPARTILHADO por todos os clientes. */
  workerConcurrency: number;
  /** Teto de emails por minuto na fila inteira (limiter do BullMQ, ancorado no Redis). */
  ratePerMinute: number;
  /** Quem mexeu por último — auditoria mínima de uma configuração sensível. */
  updatedByEmail: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PlatformSettingsDocument = HydratedDocument<IPlatformSettings>;

export const SINGLETON_KEY = 'singleton';

/**
 * Limites de sanidade. Existem porque um erro de digitação aqui derruba a plataforma
 * inteira: concorrência absurda estoura o event loop (o worker roda no processo da API)
 * e as conexões do Mongo; taxa absurda queima a reputação do domínio no provedor.
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
