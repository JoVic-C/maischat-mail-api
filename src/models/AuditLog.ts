import { type HydratedDocument, model, Schema, type Types } from 'mongoose';

/**
 * Rastro de acessos sensíveis da administração da plataforma. O superadmin pode ver
 * endereços de destinatários dos clientes, e pela LGPD a plataforma é operadora desses
 * dados. Fica acima dos clientes, sem o plugin tenantScope.
 */
export interface IAuditLog {
  /** O email é guardado para o registro sobreviver à exclusão do usuário. */
  actorEmail: string;
  actorId: Types.ObjectId | null;
  /** Vocabulário fechado, ex.: 'platform.failures.read'. */
  action: string;
  tenantId: Types.ObjectId | null;
  detail: string;
  ip: string;
  createdAt: Date;
}

export type AuditLogDocument = HydratedDocument<IAuditLog>;

const auditLogSchema = new Schema<IAuditLog>(
  {
    actorEmail: { type: String, required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    detail: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Retenção de 180 dias.
auditLogSchema.index({ createdAt: -1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export default model<IAuditLog>('AuditLog', auditLogSchema);
