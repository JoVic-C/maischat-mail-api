import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../../app';
import { criarCliente, criarContato, criarSuperadmin } from './fabricas';

// Bate na API real: não adianta o service estar certo se a rota esquecer o middleware de escopo.
describe('isolamento entre clientes', () => {
  it('a listagem só devolve contatos do próprio cliente', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    await criarContato(a.tenant._id, 'contato-do-a@x.com');
    await criarContato(b.tenant._id, 'contato-do-b@x.com');

    const res = await request(app).get('/api/contacts').set(a.auth).expect(200);

    const emails = res.body.contacts.map((c: { email: string }) => c.email);
    expect(emails).toContain('contato-do-a@x.com');
    expect(emails).not.toContain('contato-do-b@x.com');
    expect(res.body.total).toBe(1);
  });

  it('buscar pelo email do outro cliente não encontra nada', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    await criarContato(b.tenant._id, 'segredo-do-b@x.com');

    const res = await request(app).get('/api/contacts').query({ search: 'segredo-do-b' }).set(a.auth).expect(200);

    expect(res.body.total).toBe(0);
  });

  it('acessar um contato de outro cliente pelo id devolve 404, não os dados', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const alheio = await criarContato(b.tenant._id, 'contato-do-b@x.com');

    // 404 e não 403: "proibido" confirmaria que o id existe em outro cliente.
    await request(app).get(`/api/contacts/${alheio._id}`).set(a.auth).expect(404);
  });

  it('excluir um contato de outro cliente não o remove', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const alheio = await criarContato(b.tenant._id, 'contato-do-b@x.com');

    await request(app).delete(`/api/contacts/${alheio._id}`).set(a.auth);

    const aindaExiste = await request(app).get(`/api/contacts/${alheio._id}`).set(b.auth).expect(200);
    expect(aindaExiste.body.email).toBe('contato-do-b@x.com');
  });

  it('o superadmin precisa dizer em qual cliente está operando', async () => {
    const { auth } = await criarSuperadmin();
    await request(app).get('/api/contacts').set(auth).expect(400);
  });

  it('com o header, o superadmin enxerga o cliente indicado — e só ele', async () => {
    const { auth } = await criarSuperadmin();
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    await criarContato(a.tenant._id, 'contato-do-a@x.com');
    await criarContato(b.tenant._id, 'contato-do-b@x.com');

    const res = await request(app)
      .get('/api/contacts')
      .set({ ...auth, 'X-Tenant-Id': String(a.tenant._id) })
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.contacts[0].email).toBe('contato-do-a@x.com');
  });
});
