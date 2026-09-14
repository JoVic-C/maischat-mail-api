import bcrypt from 'bcryptjs';
import { type HydratedDocument, type Model, model, Schema, type Types } from 'mongoose';

/**
 * superadmin → opera a plataforma; não pertence a um cliente
 * admin      → administra um cliente
 * user       → opera o dia a dia do cliente
 */
export type UserRole = 'superadmin' | 'admin' | 'user';

export interface IUser {
  /** null apenas para superadmin. */
  tenantId: Types.ObjectId | null;
  email: string;
  password: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  /** Incrementado a cada revogação; invalida todos os JWT emitidos antes. */
  tokenVersion: number;
  /** Só o hash do token: acesso ao banco não permite reconstruir o link. */
  inviteTokenHash: string | null;
  inviteExpiresAt: Date | null;
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
    // Único na plataforma: o login é só email e senha, então o mesmo endereço em dois
    // clientes tornaria a autenticação ambígua.
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
    toJSON: {
      transform(_doc, ret) {
        delete (ret as { password?: string }).password;
        return ret;
      },
    },
  }
);

userSchema.index({ tenantId: 1, role: 1 });

// Sem o plugin tenantScope: o login precisa achar o usuário antes de haver contexto.

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
