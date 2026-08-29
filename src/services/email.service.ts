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
  /** true = envio de teste: personaliza mas NÃO injeta pixel/links/rodapé de tracking. */
  skipTracking?: boolean;
}

export interface SendEmailResult {
  messageId: string;
}

export class EmailService {
  private get baseUrl(): string {
    return process.env.PUBLIC_API_URL || 'http://localhost:3000';
  }
  /** Cache de transporters (pool) por credencial — evita abrir uma conexão SMTP nova a cada email. */
  private transporters = new Map<string, Transporter>();

  /** Teto do cache: cada entrada segura um pool de até 5 conexões TCP abertas. */
  private static readonly MAX_TRANSPORTERS = 20;

  /** A chave inclui a senha; o hash evita manter credencial em texto na memória do processo. */
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
      // Cache cheio: fecha o pool inserido há mais tempo (Map preserva ordem de inserção).
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

  /** Pixel 1x1 de abertura, apontando para a nossa rota de tracking. */
  private trackingPixel(campaignId: string, sendLogId: string): string {
    const url = `${this.baseUrl}/api/tracking/open/${campaignId}/${sendLogId}`;
    return `<img src="${url}" width="1" height="1" alt="" style="display:none" />`;
  }

  /** URL assinada de descadastro — usada no rodapé e no cabeçalho List-Unsubscribe. */
  private unsubscribeUrl(campaignId: string, sendLogId: string): string {
    const sig = signUnsubscribe(campaignId, sendLogId);
    return `${this.baseUrl}/api/tracking/unsubscribe/${campaignId}/${sendLogId}?sig=${sig}`;
  }

  /** Bloco de rodapé com o link de descadastro. */
  private unsubscribeFooter(campaignId: string, sendLogId: string): string {
    const url = this.unsubscribeUrl(campaignId, sendLogId);
    return `<div style="margin-top:24px;font-size:12px;color:#888;text-align:center">
      Não quer mais receber? <a href="${url}">Cancelar inscrição</a>
    </div>`;
  }

  /** Reescreve os links do email para passarem pelo redirect de tracking (aspas simples ou duplas). */
  private rewriteLinks(html: string, campaignId: string, sendLogId: string): string {
    return html.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (_match, quote: string, originalUrl: string) => {
      const encoded = encodeURIComponent(originalUrl);
      const sig = signLink(campaignId, sendLogId, originalUrl); // assina p/ o redirect confiar depois
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

  /** Gera uma versão em TEXTO puro a partir do HTML — melhora entregabilidade
   *  (reduz spam score) e atende clientes que não renderizam HTML. */
  private htmlToText(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '') // remove blocos <style>
      .replace(/<script[\s\S]*?<\/script>/gi, '') // remove <script>
      .replace(/<br\s*\/?>/gi, '\n') // <br> vira quebra de linha
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n') // fim de bloco vira quebra
      .replace(/<[^>]+>/g, '') // remove as demais tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ') // colapsa espaços
      .replace(/\n{3,}/g, '\n\n') // no máx. 1 linha em branco
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim();
  }

  /**
   * Email transacional (convite, aviso de conta) — não é campanha.
   *
   * Sem tracking, sem rodapé de descadastro e sem cabeçalho List-Unsubscribe: são
   * mensagens operacionais que o destinatário não pode "cancelar" sem perder o acesso,
   * e marcá-las como marketing prejudicaria a entregabilidade das duas coisas.
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
    // Teste: só personaliza. Envio real: injeta tracking (pixel/links/rodapé).
    const html = params.skipTracking ? Handlebars.compile(params.htmlTemplate)(params.data) : this.buildHtml(params);
    // Versão texto (alternativa) gerada do conteúdo personalizado, sem os artefatos de tracking.
    const text = this.htmlToText(Handlebars.compile(params.htmlTemplate)(params.data));
    // Anexos: lê sempre de uploads/ (basename blinda contra path traversal).
    const attachments = (params.attachments ?? []).map((a) => ({
      filename: a.filename,
      path: path.join('uploads', path.basename(a.storedName)),
    }));

    const info = await transporter.sendMail({
      from: `"${params.smtp.fromName}" <${params.smtp.fromEmail}>`,
      to: params.to,
      subject,
      html,
      text, // multipart/alternative: cliente escolhe HTML ou texto
      attachments, // anexos da campanha
      ...(params.skipTracking
        ? {}
        : {
            headers: {
              // Cabeçalho padrão: alguns clientes mostram um botão nativo de descadastro.
              'List-Unsubscribe': `<${this.unsubscribeUrl(params.campaignId, params.sendLogId)}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', // RFC 8058: descadastro em 1 clique (POST)
            },
          }),
    });

    return { messageId: info.messageId };
  }
}

export default new EmailService();
