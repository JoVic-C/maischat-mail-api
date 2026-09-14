import crypto from 'node:crypto';
import { requireTenantId } from '../config/tenantContext';
import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import User, { type IUser, type UserDocument } from '../models/User';
import inviteService, { type InviteLink } from './invite.service';
import passwordResetService, { type ResetLink } from './passwordReset.service';

export interface SaveUserInput {
  id?: string;
  email: string;
  name?: string;
  password?: string;
  role?: IUser['role'];
  isActive?: boolean;
}

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: IUser['role'];
  isActive: boolean;
  createdAt?: Date;
  pendingInvite: boolean;
}

export interface SaveUserResult {
  user: SafeUser;
  /** Só presente quando um usuário novo foi criado sem senha. */
  invite?: InviteLink & { emailSent: boolean };
}

export class UserService {
  private toSafe(user: UserDocument): SafeUser {
    return {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: (user as UserDocument & { createdAt?: Date }).createdAt,
      pendingInvite: Boolean(user.inviteTokenHash),
    };
  }

  /**
   * O User não leva o plugin tenantScope (o login precisa achá-lo antes de haver contexto),
   * então o escopo é explícito e vem sempre do contexto da requisição.
   */
  private scope(): { tenantId: unknown } {
    const tenantId = requireTenantId();
    if (!tenantId) throw new BadRequestError('Operação exige um cliente no contexto.');
    return { tenantId };
  }

  async list(): Promise<SafeUser[]> {
    const users = await User.find(this.scope()).sort({ createdAt: -1 });
    return users.map((u) => this.toSafe(u));
  }

  async getById(id: string): Promise<UserDocument> {
    const user = await User.findOne({ _id: id, ...this.scope() });
    if (!user) throw new NotFoundError('Usuário não encontrado.');
    return user;
  }

  /** Na criação a senha é opcional: sem ela o usuário recebe um convite e define a própria. */
  async save(data: SaveUserInput, actingUserId: string): Promise<SaveUserResult> {
    const email = data.email.toLowerCase().trim();

    if (!data.id) {
      const scope = this.scope();
      // Email é único na plataforma inteira.
      const clash = await User.findOne({ email });
      if (clash) throw new ConflictError('Já existe um usuário com este email.');
      const created = await User.create({
        ...scope,
        email,
        name: data.name ?? '',
        password: data.password || crypto.randomBytes(32).toString('base64url'),
        role: data.role ?? 'user',
        isActive: data.isActive ?? true,
      });

      if (data.password) return { user: this.toSafe(created) };

      const invite = await inviteService.issueAndSend(created);
      return { user: this.toSafe(created), invite };
    }

    const user = await this.getById(data.id);
    if (email !== user.email) {
      const clash = await User.findOne({ email });
      if (clash) throw new ConflictError('Já existe um usuário com este email.');
      user.email = email;
    }
    if (data.name !== undefined) user.name = data.name;

    // Impede que o cliente fique sem nenhum administrador ativo.
    const isSelf = String(user._id) === actingUserId;
    if (data.role !== undefined && data.role !== user.role) {
      if (isSelf) throw new BadRequestError('Você não pode alterar o próprio papel.');
      user.role = data.role;
    }
    if (data.isActive !== undefined && data.isActive !== user.isActive) {
      if (isSelf) throw new BadRequestError('Você não pode desativar a própria conta.');
      user.isActive = data.isActive;
      if (!data.isActive) user.tokenVersion += 1;
    }

    if (data.password) {
      user.password = data.password;
      user.tokenVersion += 1;
    }

    await user.save();
    return { user: this.toSafe(user) };
  }

  /** Para suporte a quem não recebe o email; quem gera não fica sabendo a senha. */
  async issueResetLink(id: string): Promise<ResetLink & { emailSent: boolean }> {
    const user = await this.getById(id);
    if (user.inviteTokenHash) {
      throw new BadRequestError('Este usuário ainda não aceitou o convite — reenvie o convite em vez de redefinir.');
    }
    return passwordResetService.issueAndSend(user);
  }

  async resendInvite(id: string): Promise<InviteLink & { emailSent: boolean }> {
    const user = await this.getById(id);
    return inviteService.resend(user);
  }

  async remove(id: string, actingUserId: string): Promise<void> {
    if (id === actingUserId) throw new BadRequestError('Você não pode excluir a própria conta.');
    const user = await this.getById(id);

    if (user.role === 'admin') {
      const admins = await User.countDocuments({ role: 'admin', isActive: true, ...this.scope() });
      if (admins <= 1) throw new BadRequestError('Não é possível excluir o último administrador ativo.');
    }
    await user.deleteOne();
  }

  async revokeSessions(id: string): Promise<void> {
    const user = await this.getById(id);
    user.tokenVersion += 1;
    await user.save();
  }
}

export default new UserService();
