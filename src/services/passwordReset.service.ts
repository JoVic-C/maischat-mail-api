import crypto from 'node:crypto';
import { runWithTenant } from '../config/tenantContext';
import { BadRequestError } from '../errors';
import Tenant from '../models/Tenant';
import User, { type UserDocument } from '../models/User';
import { logSideEffect, logWarn } from '../utils/logger';
import authService, { type AuthResult } from './auth.service';
import emailService from './email.service';
import smtpService from './smtp.service';

/**
 * Recuperação de senha.
 *
 * Mesma mecânica do convite — token aleatório, guardado só como hash, com validade
 * e uso único — mas em campos próprios do usuário, porque "nunca entrou" e "esqueceu
 * a senha" são estados distintos.
 *
 * Dois caminhos chegam aqui:
 * - a própria pessoa, pela tela de login ("esqueci minha senha");
 * - um admin/superadmin, gerando o link para dar suporte a quem não recebe o email.
 */

/** Validade curta de propósito: é uma credencial de acesso trafegando por email. */
const RESET_TTL_MS = Number(process.env.PASSWORD_RESET_TTL_MINUTES || 60) * 60 * 1000;

export interface ResetLink {
  url: string;
  expiresAt: Date;
}

export interface ResetPreview {
  email: string;
  name: string;
}

export class PasswordResetService {
  private hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private baseUrl(): string {
    return (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/+$/, '');
  }

  /** Gera (ou regenera) o link. Regenerar invalida o anterior. */
  async issue(user: UserDocument): Promise<ResetLink> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);

    user.resetTokenHash = this.hash(token);
    user.resetExpiresAt = expiresAt;
    await user.save();

    return { url: `${this.baseUrl()}/redefinir-senha?token=${token}`, expiresAt };
  }

  private async findByToken(token: string): Promise<UserDocument> {
    if (!token) throw new BadRequestError('Link inválido.');

    const user = await User.findOne({ resetTokenHash: this.hash(token) });
    // Mensagem única para inexistente e expirado — não revela qual dos dois é.
    if (!user || !user.resetExpiresAt || user.resetExpiresAt.getTime() < Date.now()) {
      throw new BadRequestError('Link inválido ou expirado. Peça uma nova recuperação de senha.');
    }
    if (!user.isActive) throw new BadRequestError('Esta conta está desativada.');
    return user;
  }

  /** Dados mínimos para a tela se apresentar. */
  async preview(token: string): Promise<ResetPreview> {
    const user = await this.findByToken(token);
    return { email: user.email, name: user.name };
  }

  /** Consome o link: define a senha, revoga as sessões antigas e já entra. */
  async reset(token: string, password: string): Promise<AuthResult> {
    const user = await this.findByToken(token);

    user.password = password; // o pre('save') do schema faz o hash
    user.resetTokenHash = null;
    user.resetExpiresAt = null;
    // Quem pediu recuperação pode ter tido a conta acessada: derruba tudo que existia.
    user.tokenVersion += 1;
    await user.save();

    return { token: authService.signToken(user._id, user.tokenVersion), user: authService.toPublicUser(user) };
  }

  /**
   * Pedido feito na tela de login.
   *
   * NÃO diz se o email existe: a resposta é sempre a mesma. Um endpoint público que
   * diferencia "enviamos" de "não encontrado" vira ferramenta de enumeração de contas.
   */
  async requestByEmail(email: string): Promise<void> {
    const normalizado = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizado });

    if (!user || !user.isActive) {
      logWarn('passwordReset.request', `pedido para email sem conta ativa (${normalizado})`);
      return;
    }
    if (user.tenantId) {
      const tenant = await Tenant.findById(user.tenantId).select('isActive').lean();
      if (!tenant?.isActive) {
        logWarn('passwordReset.request', `pedido de usuário de cliente desativado (${normalizado})`);
        return;
      }
    }

    const link = await this.issue(user);
    await this.sendByEmail(user, link);
  }

  /**
   * Envia o link por email. Best-effort: se o cliente ainda não tem SMTP e não há
   * xMailer, o admin ainda consegue gerar e repassar o link pelo painel.
   */
  async sendByEmail(user: UserDocument, link: ResetLink): Promise<{ emailSent: boolean }> {
    // A recuperação parte de uma rota PÚBLICA, sem cliente no contexto. O SMTP é do
    // cliente do usuário, então o escopo é aberto aqui a partir do dono do email —
    // sem isso o plugin tenantScope recusa a query (e faz certo).
    const smtp =
      (user.tenantId
        ? await runWithTenant(String(user.tenantId), async () => await smtpService.getDefaultForSending())
        : null) ?? smtpService.getFallbackSmtp();
    if (!smtp) return { emailSent: false };

    const minutos = Math.round(RESET_TTL_MS / 60_000);

    try {
      await emailService.sendTransactional({
        smtp,
        to: user.email,
        subject: 'Redefinir sua senha do mMail',
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
          <h2 style="color:#0f172a">Redefinir senha</h2>
          <p>Recebemos um pedido para redefinir a senha desta conta. Clique no botão abaixo para escolher uma nova.</p>
          <p style="margin:28px 0">
            <a href="${link.url}" style="background:#f97316;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
              Definir nova senha
            </a>
          </p>
          <p style="font-size:13px;color:#64748b">
            O link vale por ${minutos} minutos e só pode ser usado uma vez.
            <strong>Se não foi você que pediu, ignore este email</strong> — sua senha atual continua valendo.
          </p>
        </div>`,
      });
      return { emailSent: true };
    } catch (err) {
      logSideEffect('passwordReset.sendByEmail', err, { to: user.email });
      return { emailSent: false };
    }
  }

  /** Usado pelo painel: gera o link e tenta enviar, devolvendo-o para repasse manual. */
  async issueAndSend(user: UserDocument): Promise<ResetLink & { emailSent: boolean }> {
    const link = await this.issue(user);
    const { emailSent } = await this.sendByEmail(user, link);
    return { ...link, emailSent };
  }
}

export default new PasswordResetService();
