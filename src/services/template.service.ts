import Handlebars from 'handlebars';
import { BadRequestError, NotFoundError } from '../errors';
import Template, { type ITemplate, type TemplateDocument } from '../models/Template';
import { escapeRegex } from '../utils/regex';

export interface SaveTemplateInput {
  id?: string;
  name: string;
  subject: string;
  html: string;
}

export interface PreviewInput {
  html: string;
  subject?: string;
  data?: Record<string, string>;
}

export interface PreviewResult {
  html: string;
  subject: string;
  variables: string[];
}

/** Dados de exemplo usados quando o preview não recebe valores. */
const SAMPLE_DATA: Record<string, string> = {
  name: 'João Silva',
  email: 'joao@empresa.com',
  company: 'Mais Chat Tecnologia',
};

export class TemplateService {
  /** Extrai os nomes de variáveis {{...}} de um texto (sem duplicar). */
  private detectVariables(...sources: string[]): string[] {
    const found = new Set<string>();
    for (const src of sources) {
      for (const match of src.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
        found.add(match[1]);
      }
    }
    return [...found];
  }

  private compile(source: string, data: Record<string, string>): string {
    try {
      return Handlebars.compile(source)(data);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BadRequestError(`Template inválido: ${detail}`);
    }
  }

  async list(search?: string): Promise<ITemplate[]> {
    const query = search ? { name: { $regex: escapeRegex(search), $options: 'i' } } : {};
    return Template.find(query).sort({ updatedAt: -1 }).lean();
  }

  async getById(id: string): Promise<TemplateDocument> {
    const template = await Template.findById(id);
    if (!template) throw new NotFoundError('Template não encontrado.');
    return template;
  }

  async save(data: SaveTemplateInput): Promise<TemplateDocument> {
    const variables = this.detectVariables(data.html, data.subject);

    if (data.id) {
      const template = await this.getById(data.id);
      template.name = data.name;
      template.subject = data.subject;
      template.html = data.html;
      template.variables = variables;
      return template.save();
    }

    return Template.create({
      name: data.name,
      subject: data.subject,
      html: data.html,
      variables,
    });
  }

  async preview(input: PreviewInput): Promise<PreviewResult> {
    const data = { ...SAMPLE_DATA, ...input.data };
    return {
      html: this.compile(input.html, data),
      subject: input.subject ? this.compile(input.subject, data) : '',
      variables: this.detectVariables(input.html, input.subject ?? ''),
    };
  }

  async duplicate(id: string): Promise<TemplateDocument> {
    const original = await this.getById(id);
    return Template.create({
      name: `${original.name} (cópia)`,
      subject: original.subject,
      html: original.html,
      variables: original.variables,
    });
  }

  async remove(id: string): Promise<void> {
    const template = await this.getById(id);
    await template.deleteOne();
  }
}

export default new TemplateService();
