import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { BadRequestError, ForbiddenError, UnauthorizedError } from '../errors';
import Tenant from '../models/Tenant';
import User, { type UserDocument } from '../models/User';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  /** null para superadmin. */
  tenantId: string | null;
}
export interface AuthResult {
  token: string;
  user: PublicUser;
}

/** `v` é a versão do token, comparada com `tokenVersion` para revogar sessões. */
export interface JwtPayload {
  id: string;
  v: number;
  iat?: number;
}

/** Renova no máximo a cada 15 min: o prazo de inatividade vale a partir do último uso. */
const RENEW_AFTER_SECONDS = 15 * 60;

export function sessionIdleSeconds(): number {
  const hours = Number(process.env.SESSION_IDLE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600;
}

export class AuthService {
  signToken(id: Types.ObjectId | string, tokenVersion: number): string {
    return jwt.sign({ id: String(id), v: tokenVersion }, process.env.JWT_SECRET as string, {
      expiresIn: sessionIdleSeconds(),
    });
  }

  shouldRenew(payload: JwtPayload): boolean {
    return typeof payload.iat === 'number' && Date.now() / 1000 - payload.iat >= RENEW_AFTER_SECONDS;
  }

  toPublicUser(user: UserDocument): PublicUser {
    return {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId ? String(user.tenantId) : null,
    };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !(await user.comparePassword(password))) {
      throw new UnauthorizedError('E-mail ou senha inválidos.');
    }
    // 403, não 401: a credencial está certa e o acesso é negado por política, como no requireAuth.
    if (!user.isActive) throw new ForbiddenError('Conta desativada.');

    if (user.tenantId) {
      const tenant = await Tenant.findById(user.tenantId).select('isActive').lean();
      if (!tenant || !tenant.isActive) throw new ForbiddenError('Cliente desativado.');
    }

    return { token: this.signToken(user._id, user.tokenVersion), user: this.toPublicUser(user) };
  }

  /** Logout em todos os dispositivos: incrementa a versão, e o requireAuth recusa os tokens antigos. */
  async revokeSessions(userId: string): Promise<void> {
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ token: string }> {
    // Recarrega com a senha: o documento do requireAuth vem com `.select('-password')`.
    const user = await User.findById(userId);
    if (!user) throw new UnauthorizedError('Usuário não encontrado.');

    if (!(await user.comparePassword(currentPassword))) {
      throw new UnauthorizedError('Senha atual incorreta.');
    }
    if (newPassword === currentPassword) {
      throw new BadRequestError('A nova senha deve ser diferente da atual.');
    }
    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();
    return { token: this.signToken(user._id, user.tokenVersion) };
  }
}

export default new AuthService();
