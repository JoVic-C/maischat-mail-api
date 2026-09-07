import { type HydratedDocument, model, Schema, type Types } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export type CampaignStatus = 'draft' | 'scheduled' | 'queued' | 'sending' | 'paused' | 'completed' | 'failed';

export interface ICampaignStats {
  total: number;
  sent: number;
  failed: number;
  bounced: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
}

/** Cliques agregados por URL do email (ranking de links). */
export interface ILinkStat {
  url: string;
  clicks: number;
}

/** Anexo da campanha (enviado junto com cada email). */
export interface ICampaignAttachment {
  filename: string; // nome original (o destinatário vê este)
  storedName: string; // nome no disco (uploads/)
  size: number;
}

/** Conteúdo congelado no disparo — ver o comentário do campo `snapshot` no schema. */
export interface ICampaignSnapshot {
  subject: string;
  html: string;
}

export interface ICampaign {
  /** Cliente dono do registro. Preenchido automaticamente pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  name: string;
  templateId: Types.ObjectId;
  listIds: Types.ObjectId[];
  smtpId: Types.ObjectId | null;
  segmentId: Types.ObjectId | null; // filtro opcional de destinatários
  status: CampaignStatus;
  stats: ICampaignStats;
  linkStats: ILinkStat[];
  attachments: ICampaignAttachment[];
  snapshot: ICampaignSnapshot | null;
  scheduledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CampaignDocument = HydratedDocument<ICampaign>;

const statsSchema = new Schema<ICampaignStats>(
  {
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    bounced: { type: Number, default: 0 },
    opened: { type: Number, default: 0 },
    clicked: { type: Number, default: 0 },
    unsubscribed: { type: Number, default: 0 },
  },
  { _id: false }
);

const linkStatSchema = new Schema<ILinkStat>(
  {
    url: { type: String, required: true },
    clicks: { type: Number, default: 0 },
  },
  { _id: false }
);

const attachmentSchema = new Schema<ICampaignAttachment>(
  {
    filename: { type: String, required: true },
    storedName: { type: String, required: true },
    size: { type: Number, default: 0 },
  },
  { _id: false }
);

const snapshotSchema = new Schema<ICampaignSnapshot>(
  {
    subject: { type: String, required: true },
    html: { type: String, required: true },
  },
  { _id: false }
);

const campaignSchema = new Schema<ICampaign>(
  {
    name: { type: String, required: true, trim: true, index: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template', required: true },
    listIds: [{ type: Schema.Types.ObjectId, ref: 'List', required: true }],
    smtpId: { type: Schema.Types.ObjectId, ref: 'SmtpSettings', default: null },
    segmentId: { type: Schema.Types.ObjectId, ref: 'Segment', default: null },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'queued', 'sending', 'paused', 'completed', 'failed'],
      default: 'draft',
      index: true,
    },
    stats: { type: statsSchema, default: () => ({}) },
    linkStats: { type: [linkStatSchema], default: [] },
    attachments: { type: [attachmentSchema], default: [] },
    /**
     * Cópia do conteúdo no momento do disparo.
     *
     * Existe por DOIS motivos. Primeiro, tamanho: antes o HTML ia dentro de cada job da
     * fila, então uma campanha de milhões de destinatários duplicava o mesmo email
     * milhões de vezes no Redis. Aqui há UMA cópia por campanha.
     *
     * Segundo, imutabilidade: nada impede editar o template enquanto a campanha envia.
     * Congelar o conteúdo aqui garante que todos recebam o mesmo email — antes essa
     * garantia vinha, sem querer, da cópia por job.
     */
    snapshot: { type: snapshotSchema, default: null },
    scheduledAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

campaignSchema.plugin(tenantScope);

export default model<ICampaign>('Campaign', campaignSchema);
