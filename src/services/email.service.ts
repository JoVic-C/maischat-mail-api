import crypto from 'node:crypto';
import path from 'node:path';
import Handlebars from 'handlebars';
import nodemailer, { type Transporter } from 'nodemailer';
import type { ISmtpSettings } from '../models/SmtpSettings';
import { signLink, signUnsubscribe } from '../utils/trackingSign';

export interface SendEmailParams {
  smtp: ISmtpSettings;
  to: string;
  subjectTemplate: string;
  htmlTemplate: string;
  data: Record<string, string>;
  campaignId: string;
  sendLogId: string;
  attachments?: { filename: string; storedName: string }[];
  /** Envio de teste: personaliza sem injetar pixel, links rastreados ou rodapé. */
  skipTracking?: boolean;
}

export interface SendEmailResult {
  messageId: string;
}

export class EmailService {
  private get baseUrl(): string {
    return process.env.PUBLIC_API_URL || 'http://localhost:3000';
  }

  private transporters = new Map<string, Transporter>();

  /** Cada entrada segura um pool de até 5 conexões TCP. */
  private static readonly MAX_TRANSPORTERS = 20;

  /** Hash para não manter a senha em texto como chave de cache. */
  private cacheKey(smtp: ISmtpSettings): string {
    return crypto
      .createHash('sha256')
      .update(`${smtp.host}:${smtp.port}:${smtp.secure}:${smtp.user}:${smtp.password}`)
      .digest('hex');
  }

  private buildTransporter(smtp: ISmtpSettings): Transporter {
    const key = this.cacheKey(smtp);
    let transporter = this.transporters.get(key);
    if (!transporter) {
      if (this.transporters.size >= EmailService.MAX_TRANSPORTERS) {
        const oldestKey = this.transporters.keys().next().value as string;
        this.transporters.get(oldestKey)?.close();
        this.transporters.delete(oldestKey);
      }
      transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure ?? smtp.port === 465,
        auth: { user: smtp.user, pass: smtp.password },
        pool: true,
        maxConnections: 5,
      });
      this.transporters.set(key, transporter);
    }
    return transporter;
  }

  private trackingPixel(campaignId: string, sendLogId: string): string {
    const url = `${this.baseUrl}/api/tracking/open/${campaignId}/${sendLogId}`;
    return `<img src="${url}" width="1" height="1" alt="" style="display:none" />`;
  }

  private unsubscribeUrl(campaignId: string, sendLogId: string): string {
    const sig = signUnsubscribe(campaignId, sendLogId);
    return `${this.baseUrl}/api/tracking/unsubscribe/${campaignId}/${sendLogId}?sig=${sig}`;
  }

  private unsubscribeFooter(campaignId: string, sendLogId: string): string {
    const url = this.unsubscribeUrl(campaignId, sendLogId);
    return `<div style="margin-top:24px;font-size:12px;color:#888;text-align:center">
      Não quer mais receber? <a href="${url}">Cancelar inscrição</a>
    </div>`;
  }

  private rewriteLinks(html: string, campaignId: string, sendLogId: string): string {
    return html.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (_match, quote: string, originalUrl: string) => {
      const encoded = encodeURIComponent(originalUrl);
      const sig = signLink(campaignId, sendLogId, originalUrl);
      const tracked = `${this.baseUrl}/api/tracking/click/${campaignId}/${sendLogId}?url=${encoded}&sig=${sig}`;
      return `href=${quote}${tracked}${quote}`;
    });
  }

  private buildHtml(params: SendEmailParams): string {
    const personalized = Handlebars.compile(params.htmlTemplate)(params.data);
    const withLinks = this.rewriteLinks(personalized, params.campaignId, params.sendLogId);
    const footer = this.unsubscribeFooter(params.campaignId, params.sendLogId);
    const pixel = this.trackingPixel(params.campaignId, params.sendLogId);
    return `${withLinks}${footer}${pixel}`;
  }

  /** A versão em texto melhora a entregabilidade e atende clientes sem HTML. */
  private htmlToText(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim();
  }

  /**
   * Email operacional (convite, aviso de conta): sem tracking nem List-Unsubscribe, que
   * marcariam a mensagem como marketing e prejudicariam a entregabilidade.
   */
  async sendTransactional(params: {
    smtp: ISmtpSettings;
    to: string;
    subject: string;
    html: string;
  }): Promise<SendEmailResult> {
    const transporter = this.buildTransporter(params.smtp);
    const info = await transporter.sendMail({
      from: `"${params.smtp.fromName}" <${params.smtp.fromEmail}>`,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: this.htmlToText(params.html),
    });
    return { messageId: info.messageId };
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    const transporter = this.buildTransporter(params.smtp);
    const subject = Handlebars.compile(params.subjectTemplate)(params.data);
    const html = params.skipTracking ? Handlebars.compile(params.htmlTemplate)(params.data) : this.buildHtml(params);
    const text = this.htmlToText(Handlebars.compile(params.htmlTemplate)(params.data));
    // basename impede path traversal no nome armazenado.
    const attachments = (params.attachments ?? []).map((a) => ({
      filename: a.filename,
      path: path.join('uploads', path.basename(a.storedName)),
    }));

    const info = await transporter.sendMail({
      from: `"${params.smtp.fromName}" <${params.smtp.fromEmail}>`,
      to: params.to,
      subject,
      html,
      text,
      attachments,
      ...(params.skipTracking
        ? {}
        : {
            headers: {
              'List-Unsubscribe': `<${this.unsubscribeUrl(params.campaignId, params.sendLogId)}>`,
              // RFC 8058: descadastro em um clique.
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }),
    });

    return { messageId: info.messageId };
  }
}

export default new EmailService();
