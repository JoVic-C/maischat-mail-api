import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../../app';
import Tenant from '../../models/Tenant';
import User from '../../models/User';
import { criarCliente, criarSuperadmin } from './fabricas';

describe('login', () => {
  it('credencial correta devolve token e o usuário público', async () => {
    const { user, senha } = await criarCliente('Cliente A');

    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: senha }).expect(200);

    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(user.email);
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('senha errada é recusada', async () => {
    const { user } = await criarCliente('Cliente A');
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'errada123' }).expect(401);
  });

  it('email inexistente responde igual a senha errada', async () => {
    // Mensagens diferentes permitiriam descobrir quais emails têm conta.
    const { user, senha } = await criarCliente('Cliente A');
    const errada = await request(app).post('/api/auth/login').send({ email: user.email, password: 'errada123' });
    const inexistente = await request(app).post('/api/auth/login').send({ email: 'ninguem@x.com', password: senha });

    expect(inexistente.status).toBe(errada.status);
    expect(inexistente.body.error).toBe(errada.body.error);
  });

  it('conta desativada não entra, mesmo com a senha certa', async () => {
    const { user, senha } = await criarCliente('Cliente A');
    await User.updateOne({ _id: user._id }, { isActive: false });

    // 403, não 401: a senha está certa, então o que barra é a política, não a identidade.
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: senha }).expect(403);

    expect(res.body.error).toMatch(/desativada/i);
    expect(res.body.token).toBeUndefined();
  });

  it('cliente desativado bloqueia o login de todos os usuários dele', async () => {
    const { user, senha, tenant } = await criarCliente('Cliente A');
    await Tenant.updateOne({ _id: tenant._id }, { isActive: false });

    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: senha }).expect(403);

    expect(res.body.error).toMatch(/cliente desativado/i);
    expect(res.body.token).toBeUndefined();
  });

  it('login e rota protegida respondem o MESMO código para conta desativada', async () => {
    const { user, senha, auth } = await criarCliente('Cliente A');
    await User.updateOne({ _id: user._id }, { isActive: false });

    const noLogin = await request(app).post('/api/auth/login').send({ email: user.email, password: senha });
    const naRota = await request(app).get('/api/contacts').set(auth);

    expect(noLogin.status).toBe(naRota.status);
  });
});

describe('token', () => {
  it('sem token, rota de painel responde 401', async () => {
    await request(app).get('/api/contacts').expect(401);
  });

  it('token inválido responde 401', async () => {
    await request(app).get('/api/contacts').set({ Authorization: 'Bearer nao-e-um-token' }).expect(401);
  });

  it('token emitido antes do logout-all deixa de valer', async () => {
    const { user, auth } = await criarCliente('Cliente A');
    await request(app).get('/api/contacts').set(auth).expect(200);

    await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });

    await request(app).get('/api/contacts').set(auth).expect(401);
  });
});

describe('papéis', () => {
  it('usuário comum não alcança rota de admin', async () => {
    const comum = await criarCliente('Cliente A', 'user');
    await request(app).get('/api/smtp').set(comum.auth).expect(403);
  });

  it('admin do cliente alcança rota de admin', async () => {
    const admin = await criarCliente('Cliente A', 'admin');
    await request(app).get('/api/smtp').set(admin.auth).expect(200);
  });

  it('admin de cliente NÃO alcança a administração da plataforma', async () => {
    const admin = await criarCliente('Cliente A', 'admin');
    await request(app).get('/api/tenants').set(admin.auth).expect(403);
    await request(app).get('/api/platform-settings').set(admin.auth).expect(403);
  });

  it('superadmin alcança a administração da plataforma', async () => {
    const { auth } = await criarSuperadmin();
    await request(app).get('/api/tenants').set(auth).expect(200);
  });
});

describe('saúde e rotas inexistentes', () => {
  it('health responde sem autenticação', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('rota inexistente devolve 404 em JSON, não HTML', async () => {
    const res = await request(app).get('/api/nao-existe').expect(404);
    expect(res.body.error).toMatch(/não encontrado/i);
    // O que a resposta NÃO pode conter está em mensagensDeErro.itest.ts.
  });
});
