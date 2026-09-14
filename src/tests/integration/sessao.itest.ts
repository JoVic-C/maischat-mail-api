import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import app from '../../app';
import { criarCliente } from './fabricas';

const DIA = 24 * 3600;

function tokenEmitidoHa(userId: Types.ObjectId, versao: number, segundos: number): string {
  const iat = Math.floor(Date.now() / 1000) - segundos;
  return jwt.sign({ id: String(userId), v: versao, iat, exp: iat + DIA }, process.env.JWT_SECRET as string);
}

function validade(token: string): number {
  const { iat, exp } = jwt.decode(token) as { iat: number; exp: number };
  return exp - iat;
}

describe('sessão por inatividade', () => {
  const idleOriginal = process.env.SESSION_IDLE_HOURS;

  afterEach(() => {
    if (idleOriginal === undefined) delete process.env.SESSION_IDLE_HOURS;
    else process.env.SESSION_IDLE_HOURS = idleOriginal;
  });

  it('o token do login vale 24h', async () => {
    const a = await criarCliente('Cliente A');
    const res = await request(app).post('/api/auth/login').send({ email: a.user.email, password: a.senha }).expect(200);
    expect(validade(res.body.token)).toBe(DIA);
  });

  it('SESSION_IDLE_HOURS muda a janela', async () => {
    process.env.SESSION_IDLE_HOURS = '2';
    const a = await criarCliente('Cliente A');
    const res = await request(app).post('/api/auth/login').send({ email: a.user.email, password: a.senha }).expect(200);
    expect(validade(res.body.token)).toBe(2 * 3600);
  });

  it('token recém-emitido não é trocado a cada requisição', async () => {
    const a = await criarCliente('Cliente A');
    const res = await request(app).get('/api/contacts').set(a.auth).expect(200);
    expect(res.headers['x-session-token']).toBeUndefined();
  });

  it('usar o sistema devolve um token novo, válido por mais 24h a partir de agora', async () => {
    const a = await criarCliente('Cliente A');
    const antigo = tokenEmitidoHa(a.user._id, a.user.tokenVersion, 20 * 60);

    const res = await request(app)
      .get('/api/contacts')
      .set({ Authorization: `Bearer ${antigo}` })
      .expect(200);

    const novo = res.headers['x-session-token'];
    expect(novo).toBeTruthy();
    const { iat } = jwt.decode(novo) as { iat: number };
    expect(Math.abs(iat - Date.now() / 1000)).toBeLessThan(5);
    expect(validade(novo)).toBe(DIA);
    await request(app)
      .get('/api/contacts')
      .set({ Authorization: `Bearer ${novo}` })
      .expect(200);
  });

  it('parado há mais de 24h precisa entrar de novo', async () => {
    const a = await criarCliente('Cliente A');
    const vencido = tokenEmitidoHa(a.user._id, a.user.tokenVersion, DIA + 60);

    const res = await request(app)
      .get('/api/contacts')
      .set({ Authorization: `Bearer ${vencido}` })
      .expect(401);

    expect(res.headers['x-session-token']).toBeUndefined();
  });

  it('o navegador consegue ler o token renovado (CORS)', async () => {
    const a = await criarCliente('Cliente A');
    const res = await request(app)
      .get('/api/contacts')
      .set({ ...a.auth, Origin: 'http://localhost:4200' })
      .expect(200);
    expect(res.headers['access-control-expose-headers']).toContain('X-Session-Token');
  });

  it('a rota paginada de envios continua expondo a renovação e a paginação', async () => {
    const a = await criarCliente('Cliente A');
    const antigo = tokenEmitidoHa(a.user._id, a.user.tokenVersion, 20 * 60);

    const res = await request(app)
      .get('/api/campaigns/000000000000000000000000/logs')
      .set({ Authorization: `Bearer ${antigo}`, Origin: 'http://localhost:4200' });

    const expostos = String(res.headers['access-control-expose-headers']);
    expect(expostos).toContain('X-Session-Token');
    expect(expostos).toContain('X-Total-Count');
  });
});
