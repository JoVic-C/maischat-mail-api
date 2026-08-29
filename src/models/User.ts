import bcrypt from 'bcryptjs';
import { type HydratedDocument, type Model, model, Schema, type Types } from 'mongoose';

/**
 * superadmin → opera a plataforma (cria clientes, dá suporte). Não pertence a um tenant.
 * admin      → administra UM cliente (usuários, SMTP, bounces daquele tenant).
 * user       → opera o dia a dia do cliente (contatos, listas, campanhas).
 */
export type UserRole = 'superadmin' | 'admin' | 'user';

export interface IUser {
  /** Cliente a que o usuário pertence. null apenas para superadmin. */
  tenantId: Types.ObjectId | null;
  email: string;
  password: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  /** Incrementado a cada revogação — invalida de uma vez todos os JWT emitidos antes. */
  tokenVersion: number;
  /**
   * Convite pendente. Guardamos apenas o HASH do token: quem tiver acesso ao banco
   * não consegue reconstruir o link e assumir a conta de ninguém.
   * Enquanto houver convite pendente, o usuário existe mas não consegue entrar —
   * a senha gravada é aleatória e desconhecida por todos.
   */
  inviteTokenHash: string | null;
  inviteExpiresAt: Date | null;
  /**
   * Recuperação de senha. Campos SEPARADOS do convite de propósito: "nunca entrou"
   * e "esqueceu a senha" são situações diferentes, e misturá-las faria a tela de
   * equipe marcar como convite pendente quem só pediu uma nova senha.
   */
  resetTokenHash: string | null;
  resetExpiresAt: Date | null;
}

export interface IUserMethods {
  comparePassword(plain: string): Promise<boolean>;
}

export type UserDocument = HydratedDocument<IUser, IUserMethods>;
export type UserModel = Model<IUser, Record<string, never>, IUserMethods>;

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    // Email é único na PLATAFORMA inteira (não por cliente): o login é só email +
    // senha, então o mesmo endereço em dois clientes tornaria a autenticação ambígua.
    // Quem precisa acessar dois clientes usa dois endereços.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    name: { type: String, default: '' },
    role: { type: String, enum: ['superadmin', 'admin', 'user'], default: 'user' },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    inviteTokenHash: { type: String, default: null, index: true },
    inviteExpiresAt: { type: Date, default: null },
    resetTokenHash: { type: String, default: null, index: true },
    resetExpiresAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    // remove a senha de qualquer resposta JSON (segurança extra)
    toJSON: {
      transform(_doc, ret) {
        delete (ret as { password?: string }).password;
        return ret;
      },
    },
  }
);

userSchema.index({ tenantId: 1, role: 1 });

// O User NÃO leva o plugin tenantScope: o login precisa achar o usuário antes de
// existir contexto de tenant. O escopo é aplicado explicitamente no user.service.

// Hash da senha antes de salvar — só quando ela muda (bcrypt custo 12).
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (plain: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(plain, this.password);
};

export default model<IUser, UserModel>('User', userSchema);
