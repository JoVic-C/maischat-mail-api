/**
 * Email de boas-vindas enviado quando o superadmin cria um cliente.
 *
 * Vai para o email do administrador informado na criação — que é o email do próprio
 * cliente, já que o Tenant não tem endereço próprio: o contato dele é o primeiro admin.
 *
 * O link é sempre "escolha sua senha", mas o token depende de como a conta nasceu:
 *
 * - com senha definida pelo superadmin → link de REDEFINIÇÃO. A conta já tem senha,
 *   e o admin usa o link para trocar por uma que só ele conheça.
 * - sem senha (padrão da API)          → link de CONVITE. É o estado "nunca entrou",
 *   que o codebase trata em campos próprios, com validade mais longa.
 *
 * Emitir um convite numa conta que JÁ tem senha não serviria: `inviteService.issue`
 * sobrescreve a senha por uma aleatória, e a que o superadmin escolheu deixaria de
 * valer sem ninguém ser avisado.
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
  /** URL para o admin definir a senha. Devolvida para repasse manual se o email não sair. */
  url: string;
  expiresAt: Date;
  kind: WelcomeLinkKind;
  emailSent: boolean;
}

export class TenantWelcomeService {
  /**
   * Gera o link e tenta entregar o email.
   *
   * Nunca lança: um cliente criado com sucesso não pode ser desfeito porque o email
   * não saiu. Quando a entrega falha, o link volta no retorno e o painel o mostra
   * para o superadmin repassar.
   */
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
    // O escopo é aberto à mão porque a rota de clientes roda ACIMA dos clientes, sem
    // tenantContext — sem isto o plugin tenantScope recusa a consulta ao SMTP (e faz
    // certo). Na prática o cliente acabou de nascer e ainda não tem servidor próprio,
    // então quem entrega é o SMTP da plataforma (xMailer).
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

    // Com senha definida pelo superadmin, o admin pode já ter recebido uma senha por
    // fora; o texto deixa claro que usar o link substitui aquela senha.
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

  /**
   * Descreve a validade a partir da data de expiração, em vez de reler as variáveis
   * de ambiente de cada fluxo — assim o texto do email não pode discordar do token.
   */
  private formatValidity(expiresAt: Date): string {
    const minutos = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
    if (minutos < 120) return `${minutos} minutos`;
    const horas = Math.round(minutos / 60);
    return `${horas} horas`;
  }

  /** Nome e email entram no HTML: escapa para um apóstrofo ou `<` não quebrar o email. */
  private escape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

export default new TenantWelcomeService();
