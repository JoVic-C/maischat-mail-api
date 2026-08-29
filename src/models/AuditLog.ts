import { type HydratedDocument, model, Schema, type Types } from 'mongoose';

/**
 * Registro de acessos sensíveis da administração da plataforma.
 *
 * Existe por causa de uma decisão específica: o painel de operação permite ao
 * superadmin ver endereços de destinatários que pertencem aos CLIENTES. No
 * enquadramento da LGPD a Mais Chat é operadora desses dados, então o acesso
 * precisa deixar rastro de quem viu o quê e quando.
 *
 * NÃO leva o plugin `tenantScope`: vive acima dos clientes, como o Tenant.
 */
export interface IAuditLog {
  /** Quem fez — guardamos o email para o registro sobreviver à exclusão do usuário. */
  actorEmail: string;
  actorId: Types.ObjectId | null;
  /** O que fez, em vocabulário fechado (ex.: 'platform.failures.read'). */
  action: string;
  /** Cliente envolvido, quando a ação é sobre um só. */
  tenantId: Types.ObjectId | null;
  /** Detalhe mínimo para dar sentido ao registro (quantas linhas, que filtro). */
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

// Retenção de 180 dias: tempo suficiente para auditoria, sem virar depósito eterno.
auditLogSchema.index({ createdAt: -1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export default model<IAuditLog>('AuditLog', auditLogSchema);
