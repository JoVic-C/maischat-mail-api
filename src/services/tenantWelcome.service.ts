/**
 * Email de boas-vindas ao primeiro admin de um cliente recém-criado.
 *
 * - conta criada com senha → link de redefinição
 * - conta sem senha        → link de convite
 *
 * Convite numa conta que já tem senha não serve: `inviteService.issue` a sobrescreve
 * por uma aleatória.
 */
import { runWithTenant } from '../config/tenantContext';
import type { TenantDocument } from '../models/Tenant';
import type { UserDocument } from '../models/User';
import { logSideEffect } from '../utils/logger';
import emailService from './email.service';
import inviteService from './invite.service';
import passwordResetService from './passwordReset.service';
import smtpService from './smtp.service';

export type WelcomeLinkKind = 'invite' | 'reset';

export interface TenantWelcomeResult {
  /** Devolvida para repasse manual se o email não sair. */
  url: string;
  expiresAt: Date;
  kind: WelcomeLinkKind;
  emailSent: boolean;
}

export class TenantWelcomeService {
  /** Nunca lança: o cliente já foi criado e não pode ser desfeito por falha no email. */
  async send(tenant: TenantDocument, admin: UserDocument, hasPassword: boolean): Promise<TenantWelcomeResult> {
    const kind: WelcomeLinkKind = hasPassword ? 'reset' : 'invite';
    const link = hasPassword ? await passwordResetService.issue(admin) : await inviteService.issue(admin);
    const emailSent = await this.deliver(tenant, admin, link.url, link.expiresAt, kind);
    return { url: link.url, expiresAt: link.expiresAt, kind, emailSent };
  }

  private async deliver(
    tenant: TenantDocument,
    admin: UserDocument,
    url: string,
    expiresAt: Date,
    kind: WelcomeLinkKind
  ): Promise<boolean> {
    // A rota de clientes roda sem tenantContext; o escopo é aberto à mão para consultar o SMTP.
    const proprio = await runWithTenant(String(tenant._id), async () => await smtpService.getDefaultForSending());
    const smtp = proprio ?? smtpService.getFallbackSmtp();
    if (!smtp) {
      logSideEffect('tenantWelcome.deliver', new Error('Sem SMTP da plataforma configurado (XMAILER_SMTP_*).'), {
        to: admin.email,
        tenant: tenant.slug,
      });
      return false;
    }

    try {
      await emailService.sendTransactional({
        smtp,
        to: admin.email,
        subject: `Bem-vindo ao mMail — acesso a ${tenant.name}`,
        html: this.buildHtml(tenant, admin, url, expiresAt, kind),
      });
      return true;
    } catch (err) {
      logSideEffect('tenantWelcome.deliver', err, { to: admin.email, tenant: tenant.slug });
      return false;
    }
  }

  private buildHtml(
    tenant: TenantDocument,
    admin: UserDocument,
    url: string,
    expiresAt: Date,
    kind: WelcomeLinkKind
  ): string {
    const saudacao = admin.name ? `Olá, ${this.escape(admin.name)}` : 'Olá';
    const validade = this.formatValidity(expiresAt);
    const acao = kind === 'reset' ? 'Definir minha senha' : 'Criar minha senha';

    const observacao =
      kind === 'reset'
        ? 'Se você recebeu uma senha provisória, usar o link acima substitui essa senha por uma que só você conhece.'
        : 'Este é o seu primeiro acesso — a conta só fica ativa depois que você definir a senha.';

    return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
      <h2 style="color:#0f172a">Bem-vindo ao mMail</h2>
      <p>${saudacao}! A conta <strong>${this.escape(tenant.name)}</strong> foi criada no mMail e você é o
      administrador dela.</p>
      <p>Seu acesso é o email <strong>${this.escape(admin.email)}</strong>. Clique no botão abaixo para
      definir sua senha e entrar no painel.</p>
      <p style="margin:28px 0">
        <a href="${url}" style="background:#f97316;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
          ${acao}
        </a>
      </p>
      <p style="font-size:13px;color:#64748b">
        O link vale por ${validade} e só pode ser usado uma vez. ${observacao}
      </p>
      <p style="font-size:13px;color:#64748b">
        Se o link expirar, use a opção <strong>"Esqueci minha senha"</strong> na tela de login.
      </p>
    </div>`;
  }

  /** Calculada da expiração do token, para o texto nunca discordar dele. */
  private formatValidity(expiresAt: Date): string {
    const minutos = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
    if (minutos < 120) return `${minutos} minutos`;
    const horas = Math.round(minutos / 60);
    return `${horas} horas`;
  }

  private escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

export default new TenantWelcomeService();
