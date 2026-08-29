import { type HydratedDocument, model, Schema } from 'mongoose';

/** Cliente da plataforma. Cada tenant tem seus próprios contatos, listas e campanhas. */
/**
 * Fatia da capacidade de envio reservada a um cliente.
 *
 * O motor é UM só, compartilhado: estes números são pedaços da piscina definida em
 * PlatformSettings, não capacidade adicional. 0 = sem limite próprio (o cliente pode
 * usar até o teto global). Quem define é o superadmin — deixar o cliente escolher a
 * própria fatia de um recurso compartilhado permitiria que um sozinho tomasse a fila.
 */
export interface ISendingLimits {
  /** Envios simultâneos deste cliente, dentro dos slots do worker. 0 = sem limite próprio. */
  concurrency: number;
  /** Emails por minuto deste cliente. 0 = sem limite próprio. */
  ratePerMinute: number;
}

export interface ITenant {
  name: string;
  sendingLimits: ISendingLimits;
  /** Identificador legível e estável (usado em logs e URLs administrativas). */
  slug: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type TenantDocument = HydratedDocument<ITenant>;

const tenantSchema = new Schema<ITenant>(
  {
    name: { type: String, required: true, trim: true },
    sendingLimits: {
      concurrency: { type: Number, default: 0, min: 0 },
      ratePerMinute: { type: Number, default: 0, min: 0 },
    },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

// O Tenant é a raiz da hierarquia — NÃO leva o plugin tenantScope.
export default model<ITenant>('Tenant', tenantSchema);
