import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../../app';
import { runAsSystem, runWithTenant } from '../../config/tenantContext';
import AcceptedDomain from '../../models/AcceptedDomain';
import Contact from '../../models/Contact';
import SmtpSettings from '../../models/SmtpSettings';
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

  it('cadastrar SMTP com o tenantId de outro cliente grava no próprio cliente', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');

    const res = await request(app)
      .post('/api/smtp/save')
      .set(a.auth)
      .send({
        tenantId: String(b.tenant._id),
        name: 'Servidor injetado',
        host: 'smtp.atacante.test',
        port: 587,
        user: 'atacante',
        password: 'segredo',
        fromName: 'Atacante',
        fromEmail: 'atacante@x.com',
        isDefault: true,
      })
      .expect(200);

    const salvo = await runAsSystem(async () => await SmtpSettings.findById(res.body.server.id).lean());
    expect(String(salvo?.tenantId)).toBe(String(a.tenant._id));

    const doB = await request(app).get('/api/smtp').set(b.auth).expect(200);
    expect(doB.body).toEqual([]);
  });

  it('domínio aceito por um cliente continua suspeito para o outro', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');

    await request(app).post('/api/contacts/typo-domains/accept').set(a.auth).send({ domain: 'cloud.com' }).expect(200);

    const sugestao = (cliente: typeof a) =>
      request(app)
        .get('/api/contacts/email-suggestion')
        .query({ email: 'ana@cloud.com' })
        .set(cliente.auth)
        .expect(200);
    expect((await sugestao(a)).body.suggestion).toBeNull();
    expect((await sugestao(b)).body.suggestion).toBe('ana@icloud.com');

    const aceitos = await runAsSystem(async () => await AcceptedDomain.find().lean());
    expect(aceitos.map((d) => String(d.tenantId))).toEqual([String(a.tenant._id)]);
  });

  it('um update não move o documento para outro cliente', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const contato = await criarContato(a.tenant._id, 'fica-no-a@x.com');

    await runWithTenant(a.tenant._id, async () => {
      await Contact.updateOne({ _id: contato._id }, { $set: { tenantId: b.tenant._id, name: 'Renomeado' } });
    });

    const depois = await runAsSystem(async () => await Contact.findById(contato._id).lean());
    expect(String(depois?.tenantId)).toBe(String(a.tenant._id));
    expect(depois?.name).toBe('Renomeado');
  });

  it('trocar o tenantId de um documento carregado é recusado', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const contato = await criarContato(a.tenant._id, 'fica-no-a@x.com');

    await runWithTenant(a.tenant._id, async () => {
      const doc = await Contact.findById(contato._id);
      if (!doc) throw new Error('contato sumiu');
      doc.set('tenantId', b.tenant._id);
      await expect(doc.save()).rejects.toThrow(/outro cliente/);
    });
  });
});
