import crypto from 'node:crypto';
import { runWithTenant } from '../config/tenantContext';
import { BadRequestError, NotFoundError } from '../errors';
import Tenant from '../models/Tenant';
import User, { type UserDocument } from '../models/User';
import { logSideEffect } from '../utils/logger';
import authService, { type AuthResult } from './auth.service';
import emailService from './email.service';
import smtpService from './smtp.service';

/**
 * Convites de acesso.
 *
 * Não existe autocadastro: toda conta nasce de um convite feito por alguém de dentro
 * (admin do cliente, ou superadmin ao criar o cliente). O convidado recebe um link,
 * define a própria senha e entra — a senha nunca trafega por email nem fica com quem convidou.
 */

/** Validade padrão do convite. */
const INVITE_TTL_MS = Number(process.env.INVITE_TTL_HOURS || 72) * 60 * 60 * 1000;

export interface InviteLink {
  /** URL completa para o convidado abrir. Só existe neste retorno — não é persistida. */
  url: string;
  expiresAt: Date;
}

export interface InvitePreview {
  email: string;
  name: string;
  tenantName: string | null;
}

export class InviteService {
  /** Guardamos o hash; o token em claro só existe no link enviado ao convidado. */
  private hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private baseUrl(): string {
    return (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/+$/, '');
  }

  /**
   * Gera (ou regenera) o convite de um usuário. Regenerar INVALIDA o link anterior,
   * que é o comportamento esperado de um "reenviar convite".
   */
  async issue(user: UserDocument): Promise<InviteLink> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    user.inviteTokenHash = this.hash(token);
    user.inviteExpiresAt = expiresAt;
    // Enquanto o convite estiver pendente ninguém entra nesta conta: a senha é
    // aleatória e não é conhecida nem por quem convidou.
    user.password = crypto.randomBytes(32).toString('base64url');
    await user.save();

    return { url: `${this.baseUrl()}/definir-senha?token=${token}`, expiresAt };
  }

  /** Localiza o usuário de um convite válido (não expirado). */
  private async findByToken(token: string): Promise<UserDocument> {
    if (!token) throw new BadRequestError('Convite inválido.');

    const user = await User.findOne({ inviteTokenHash: this.hash(token) });
    // Mensagem única para token inexistente e expirado — não revela qual dos dois é.
    if (!user || !user.inviteExpiresAt || user.inviteExpiresAt.getTime() < Date.now()) {
      throw new BadRequestError('Convite inválido ou expirado. Peça um novo ao administrador.');
    }
    if (!user.isActive) throw new BadRequestError('Esta conta está desativada.');
    return user;
  }

  /** Dados mínimos para a tela de definir senha se apresentar ("Olá, fulano"). */
  async preview(token: string): Promise<InvitePreview> {
    const user = await this.findByToken(token);
    const tenant = user.tenantId ? await Tenant.findById(user.tenantId).select('name').lean() : null;
    return { email: user.email, name: user.name, tenantName: tenant?.name ?? null };
  }

  /** Consome o convite: define a senha, limpa o token e já devolve a sessão iniciada. */
  async accept(token: string, password: string): Promise<AuthResult> {
    const user = await this.findByToken(token);

    user.password = password; // o pre('save') do schema faz o hash
    user.inviteTokenHash = null;
    user.inviteExpiresAt = null;
    user.tokenVersion += 1; // nada emitido antes deste momento vale
    await user.save();

    return { token: authService.signToken(user._id, user.tokenVersion), user: authService.toPublicUser(user) };
  }

  /**
   * Envia o convite por email. É best-effort: se o cliente ainda não tem SMTP e não
   * há xMailer configurado, o link continua disponível para quem convidou repassar
   * — o convite nunca depende do email ter saído.
   */
  async sendByEmail(user: UserDocument, link: InviteLink): Promise<{ emailSent: boolean }> {
    // O escopo do cliente é aberto a partir do dono do convite, e não herdado da
    // requisição: o convite também parte da criação de cliente, uma rota que roda
    // ACIMA dos clientes e não tem tenantContext. Sem isto o plugin tenantScope
    // recusa a consulta ao SMTP — e como esta linha fica fora do try abaixo, o erro
    // subia e desfazia a criação do cliente inteira.
    const proprio = user.tenantId
      ? await runWithTenant(String(user.tenantId), async () => await smtpService.getDefaultForSending())
      : null;
    const smtp = proprio ?? smtpService.getFallbackSmtp();
    if (!smtp) return { emailSent: false };

    const tenant = user.tenantId ? await Tenant.findById(user.tenantId).select('name').lean() : null;
    const contexto = tenant?.name ? `na conta <strong>${tenant.name}</strong>` : 'na plataforma';
    const horas = Math.round(INVITE_TTL_MS / 3_600_000);

    try {
      await emailService.sendTransactional({
        smtp,
        to: user.email,
        subject: 'Seu acesso ao mMail',
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
          <h2 style="color:#0f172a">Bem-vindo ao mMail</h2>
          <p>Você foi convidado ${contexto}. Clique no botão abaixo para definir sua senha e acessar o painel.</p>
          <p style="margin:28px 0">
            <a href="${link.url}" style="background:#f97316;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
              Definir minha senha
            </a>
          </p>
          <p style="font-size:13px;color:#64748b">O link vale por ${horas} horas. Se você não esperava este convite, ignore este email.</p>
        </div>`,
      });
      return { emailSent: true };
    } catch (err) {
      logSideEffect('invite.sendByEmail', err, { to: user.email });
      return { emailSent: false };
    }
  }

  /** Reenvia o convite de um usuário que ainda não entrou. */
  async resend(user: UserDocument): Promise<InviteLink & { emailSent: boolean }> {
    if (!user.inviteTokenHash) {
      throw new BadRequestError('Este usuário já definiu a senha — não há convite pendente.');
    }
    const link = await this.issue(user);
    const { emailSent } = await this.sendByEmail(user, link);
    return { ...link, emailSent };
  }

  /** Usado pelo user.service ao criar alguém sem senha. */
  async issueAndSend(user: UserDocument): Promise<InviteLink & { emailSent: boolean }> {
    const link = await this.issue(user);
    const { emailSent } = await this.sendByEmail(user, link);
    return { ...link, emailSent };
  }

  async getUserOrFail(id: string, tenantFilter: Record<string, unknown>): Promise<UserDocument> {
    const user = await User.findOne({ _id: id, ...tenantFilter });
    if (!user) throw new NotFoundError('Usuário não encontrado.');
    return user;
  }
}

export default new InviteService();
