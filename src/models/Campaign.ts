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

export interface ILinkStat {
  url: string;
  clicks: number;
}

export interface ICampaignAttachment {
  /** Nome que o destinatário vê. */
  filename: string;
  /** Nome do arquivo em uploads/. */
  storedName: string;
  size: number;
}

export interface ICampaignSnapshot {
  subject: string;
  html: string;
}

export interface ICampaign {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  name: string;
  templateId: Types.ObjectId;
  listIds: Types.ObjectId[];
  smtpId: Types.ObjectId | null;
  segmentId: Types.ObjectId | null;
  status: CampaignStatus;
  /** Por que a campanha parou sozinha; nulo quando foi pausada pelo usuário. */
  pauseReason: string | null;
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
    pauseReason: { type: String, default: null },
    stats: { type: statsSchema, default: () => ({}) },
    linkStats: { type: [linkStatSchema], default: [] },
    attachments: { type: [attachmentSchema], default: [] },
    /**
     * Conteúdo congelado no disparo: uma cópia por campanha em vez de uma por job na
     * fila, e editar o template durante o envio não altera os emails desta campanha.
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
