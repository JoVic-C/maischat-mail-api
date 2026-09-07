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
  /** null para superadmin, que não pertence a nenhum cliente. */
  tenantId: string | null;
}
export interface AuthResult {
  token: string;
  user: PublicUser;
}

/** Conteúdo do JWT. `v` é a versão do token — ver `revokeSessions`. */
export interface JwtPayload {
  id: string;
  v: number;
}

export class AuthService {
  signToken(id: Types.ObjectId | string, tokenVersion: number): string {
    return jwt.sign({ id: String(id), v: tokenVersion }, process.env.JWT_SECRET as string, {
      expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'],
    });
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
    // 403 e não 401: a credencial está CERTA — a identidade foi provada e o acesso é
    // negado por política. É também o que o middleware requireAuth responde para a
    // mesma condição; os dois divergiam, e o 401 daqui ainda fazia o interceptor do
    // painel disparar um logout na própria tela de login.
    if (!user.isActive) throw new ForbiddenError('Conta desativada.');

    // Cliente desativado bloqueia o login de todos os usuários dele.
    if (user.tenantId) {
      const tenant = await Tenant.findById(user.tenantId).select('isActive').lean();
      if (!tenant || !tenant.isActive) throw new ForbiddenError('Cliente desativado.');
    }

    return { token: this.signToken(user._id, user.tokenVersion), user: this.toPublicUser(user) };
  }

  /**
   * Invalida TODOS os tokens já emitidos para o usuário (logout em todos os dispositivos).
   * Como o JWT é stateless, a revogação é feita por versão: o `requireAuth` compara o `v`
   * do token com o `tokenVersion` do usuário e recusa os antigos.
   */
  async revokeSessions(userId: string): Promise<void> {
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  }

  /** Troca a própria senha. Revoga as sessões antigas e devolve um token novo. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ token: string }> {
    // Recarrega do banco COM a senha: o documento vindo do requireAuth usa
    // `.select('-password')`, e sem o hash o comparePassword sempre falharia.
    const user = await User.findById(userId);
    if (!user) throw new UnauthorizedError('Usuário não encontrado.');

    if (!(await user.comparePassword(currentPassword))) {
      throw new UnauthorizedError('Senha atual incorreta.');
    }
    if (newPassword === currentPassword) {
      throw new BadRequestError('A nova senha deve ser diferente da atual.');
    }
    user.password = newPassword; // o pre('save') do schema faz o hash
    user.tokenVersion += 1; // derruba as sessões abertas com a senha antiga
    await user.save();
    return { token: this.signToken(user._id, user.tokenVersion) };
  }
}

export default new AuthService();
