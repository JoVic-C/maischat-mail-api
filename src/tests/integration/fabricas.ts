import type { Types } from 'mongoose';
import { runWithTenant } from '../../config/tenantContext';
import Contact from '../../models/Contact';
import Tenant from '../../models/Tenant';
import User, { type UserDocument } from '../../models/User';
import authService from '../../services/auth.service';

/** Cliente + primeiro usuário, que é o mínimo para qualquer rota do painel responder. */
export async function criarCliente(nome: string, papel: 'admin' | 'user' = 'admin', senha = 'SenhaTeste123') {
  const slug = `${nome.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
  const tenant = await Tenant.create({ name: nome, slug, isActive: true });
  const user = await User.create({
    tenantId: tenant._id,
    email: `${slug}@teste.local`,
    password: senha,
    name: `Usuário de ${nome}`,
    role: papel,
    isActive: true,
  });

  return {
    tenant,
    user,
    senha,
    token: authService.signToken(user._id, user.tokenVersion),
    /** Cabeçalho pronto para o supertest. */
    auth: { Authorization: `Bearer ${authService.signToken(user._id, user.tokenVersion)}` },
  };
}

export async function criarSuperadmin(
  senha = 'SenhaTeste123'
): Promise<{ user: UserDocument; auth: Record<string, string> }> {
  const user = await User.create({
    tenantId: null,
    email: `super-${Date.now().toString(36)}@teste.local`,
    password: senha,
    name: 'Superadmin de teste',
    role: 'superadmin',
    isActive: true,
  });
  return { user, auth: { Authorization: `Bearer ${authService.signToken(user._id, user.tokenVersion)}` } };
}

/** Contato dentro do escopo de um cliente — o plugin exige contexto ativo para gravar. */
export async function criarContato(tenantId: Types.ObjectId | string, email: string, nome = 'Contato') {
  return runWithTenant(tenantId, async () => await Contact.create({ email, name: nome }));
}
