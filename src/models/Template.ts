import type { Types } from 'mongoose';
import { type HydratedDocument, model, Schema } from 'mongoose';
import { tenantScope } from './plugins/tenantScope';

export interface ITemplate {
  /** Preenchido pelo plugin tenantScope. */
  tenantId?: Types.ObjectId;
  name: string;
  subject: string;
  html: string;
  /** Variáveis {{...}} encontradas no html e no assunto; recalculadas a cada save. */
  variables: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type TemplateDocument = HydratedDocument<ITemplate>;

const templateSchema = new Schema<ITemplate>(
  {
    name: { type: String, required: true, trim: true, index: true },
    subject: { type: String, required: true, trim: true },
    html: { type: String, required: true },
    variables: { type: [String], default: [] },
  },
  { timestamps: true }
);

templateSchema.plugin(tenantScope);

export default model<ITemplate>('Template', templateSchema);
