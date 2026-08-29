import { type HydratedDocument, model, Schema, type Types } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export type SendStatus = 'pending' | 'sent' | 'failed' | 'bounced' | 'opened' | 'clicked' | 'unsubscribed';

export interface ISendLog {
  /** Cliente dono do registro. Preenchido automaticamente pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  campaignId: Types.ObjectId;
  contactId: Types.ObjectId;
  email: string;
  status: SendStatus;
  error: string;
  messageId: string;
  openCount: number;
  clickCount: number;
  sentAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SendLogDocument = HydratedDocument<ISendLog>;

const sendLogSchema = new Schema<ISendLog>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    email: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'bounced', 'opened', 'clicked', 'unsubscribed'],
      default: 'pending',
      index: true,
    },
    error: { type: String, default: '' },
    messageId: { type: String, default: '' },
    openCount: { type: Number, default: 0 },
    clickCount: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    clickedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

sendLogSchema.index({ campaignId: 1, contactId: 1 }, { unique: true });
// Bounce/webhook busca o último envio de um email — sem este índice é collection scan.
sendLogSchema.index({ email: 1, createdAt: -1 });
// Painel de operação lista as últimas falhas de todos os clientes.
sendLogSchema.index({ status: 1, updatedAt: -1 });
// Gráfico de atividade do dashboard filtra por janela de tempo.
sendLogSchema.index({ createdAt: -1 });

sendLogSchema.plugin(tenantScope);

export default model<ISendLog>('SendLog', sendLogSchema);
