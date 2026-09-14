import nodemailer, { type Transporter } from 'nodemailer';
import { BadRequestError, NotFoundError } from '../errors';
import SmtpSettings, { type ISmtpSettings, type SmtpSettingsDocument } from '../models/SmtpSettings';
import { logSideEffect } from '../utils/logger';

export interface SaveSmtpInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
  isDefault?: boolean;
  dailyLimit?: number;
  hourlyLimit?: number;
}

export interface SmtpCredentials {
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  password: string;
}

export type SafeSmtp = Omit<ISmtpSettings, 'password'> & { id: string };

/** Id sentinela para o SMTP da plataforma, configurado pelo .env. */
export const FALLBACK_SMTP_ID = '__xmailer__';

export class SmtpService {
  /** SMTP da plataforma, usado quando o cliente não tem servidor próprio. */
  getFallbackSmtp(): ISmtpSettings | null {
    const host = process.env.XMAILER_SMTP_HOST;
    const user = process.env.XMAILER_SMTP_USER;
    const password = process.env.XMAILER_SMTP_PASS;
    if (!host || !user || !password) return null;

    const port = Number(process.env.XMAILER_SMTP_PORT) || 587;
    return {
      name: 'SMTP da plataforma',
      host,
      port,
      // A 465 é TLS direto; `false` explícito aqui anularia a regra do buildTransporter.
      secure: process.env.XMAILER_SMTP_SECURE ? process.env.XMAILER_SMTP_SECURE === 'true' : port === 465,
      user,
      password,
      fromName: process.env.XMAILER_FROM_NAME || 'mMail',
      fromEmail: process.env.XMAILER_FROM_EMAIL || user,
      isDefault: false,
      dailyLimit: 0,
      hourlyLimit: 0,
    } as ISmtpSettings;
  }

  private toSafe(doc: SmtpSettingsDocument): SafeSmtp {
    const obj = doc.toObject();
    delete (obj as { password?: string }).password;
    return { ...obj, id: String(doc._id) } as SafeSmtp;
  }

  private buildTransporter(creds: SmtpCredentials): Transporter {
    return nodemailer.createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.secure ?? creds.port === 465,
      auth: { user: creds.user, pass: creds.password },
    });
  }

  /** Devolve o documento com a senha decifrada: não exponha em resposta de API. */
  async getDefaultForSending(): Promise<ISmtpSettings | null> {
    return SmtpSettings.findOne({ isDefault: true });
  }

  async list(): Promise<SafeSmtp[]> {
    const docs = await SmtpSettings.find().sort({ isDefault: -1, createdAt: -1 });
    return docs.map((d) => this.toSafe(d));
  }

  async getById(id: string): Promise<SmtpSettingsDocument> {
    const doc = await SmtpSettings.findById(id);
    if (!doc) throw new NotFoundError('Servidor SMTP não encontrado.');
    return doc;
  }

  async save(data: SaveSmtpInput): Promise<SafeSmtp> {
    let doc: SmtpSettingsDocument;

    if (data.id) {
      doc = await this.getById(data.id);
      // Campo a campo, contra mass assignment; senha só é trocada quando enviada.
      if (data.name !== undefined) doc.name = data.name;
      if (data.host !== undefined) doc.host = data.host;
      if (data.port !== undefined) doc.port = data.port;
      if (data.secure !== undefined) doc.secure = data.secure;
      if (data.user !== undefined) doc.user = data.user;
      if (data.password) doc.password = data.password;
      if (data.fromName !== undefined) doc.fromName = data.fromName;
      if (data.fromEmail !== undefined) doc.fromEmail = data.fromEmail;
      if (data.isDefault !== undefined) doc.isDefault = data.isDefault;
      if (data.dailyLimit !== undefined) doc.dailyLimit = data.dailyLimit;
      if (data.hourlyLimit !== undefined) doc.hourlyLimit = data.hourlyLimit;
    } else {
      doc = new SmtpSettings(data);
    }
    await doc.save();

    if (doc.isDefault) {
      await SmtpSettings.updateMany({ _id: { $ne: doc._id } }, { isDefault: false });
    }
    return this.toSafe(doc);
  }

  async remove(id: string): Promise<void> {
    const doc = await this.getById(id);
    await doc.deleteOne();
  }

  async testConnection(creds: SmtpCredentials): Promise<{ ok: true }> {
    // Fora do cache do EmailService e fechado no finally, para não deixar conexão aberta.
    const transporter = this.buildTransporter(creds);
    try {
      await transporter.verify();
      return { ok: true };
    } catch (err) {
      logSideEffect('smtp.testConnection', err);
      const detail = err instanceof Error ? err.message : String(err);
      throw new BadRequestError(`Falha na conexão SMTP: ${detail}`);
    } finally {
      transporter.close();
    }
  }

  async sendTestEmail(creds: SmtpCredentials, from: string, to: string): Promise<{ messageId: string }> {
    const transporter = this.buildTransporter(creds);
    try {
      const info = await transporter.sendMail({
        from,
        to,
        subject: 'mMail — email de teste',
        html: '<h2>Funcionou! 🎉</h2><p>Seu servidor SMTP está configurado corretamente no mMail.</p>',
      });
      return { messageId: info.messageId };
    } catch (err) {
      logSideEffect('smtp.sendTestEmail', err);
      const detail = err instanceof Error ? err.message : String(err);
      throw new BadRequestError(`Falha ao enviar email de teste: ${detail}`);
    } finally {
      transporter.close();
    }
  }
}

export default new SmtpService();
