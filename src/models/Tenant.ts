import { type HydratedDocument, model, Schema } from 'mongoose';

/**
 * Fatia da capacidade do motor reservada a um cliente; não é capacidade adicional.
 * 0 significa sem limite próprio. Só o superadmin define.
 */
export interface ISendingLimits {
  concurrency: number;
  ratePerMinute: number;
}

export interface ITenant {
  name: string;
  sendingLimits: ISendingLimits;
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

// Raiz da hierarquia: sem o plugin tenantScope.
export default model<ITenant>('Tenant', tenantSchema);
