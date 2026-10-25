import type { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../../app';
import { runWithTenant } from '../../config/tenantContext';
import Contact from '../../models/Contact';
import FormSubmission from '../../models/FormSubmission';
import FormWebhook from '../../models/FormWebhook';
import SmtpSettings from '../../models/SmtpSettings';
import Template from '../../models/Template';
import { formEmailQueue } from '../../queue/formEmail.queue';
import emailService from '../../services/email.service';
import formWebhookService from '../../services/formWebhook.service';
import { criarCliente } from './fabricas';

// Sem DNS de verdade nos testes: todo domínio "recebe email".
vi.mock('../../utils/emailHygiene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/emailHygiene')>()),
  emailDomainHasMail: async () => true,
}));

type Cliente = Awaited<ReturnType<typeof criarCliente>>;

async function criarTemplate(tenantId: Types.ObjectId) {
  return runWithTenant(tenantId, async () =>
    Template.create({
      name: 'Obrigado',
      subject: 'Recebemos seu contato, {{name}}',
      html: '<p>Olá {{name}}, retornamos no {{telefone}}.</p>',
      variables: ['name', 'telefone'],
    })
  );
}

async function criarWebhook(cliente: Cliente, extra: Record<string, unknown> = {}) {
  const template = await criarTemplate(cliente.tenant._id);
  const res = await request(app)
    .post('/api/form-webhooks/save')
    .set(cliente.auth)
    .send({ name: 'Orçamento', templateId: String(template._id), ...extra })
    .expect(200);
  const webhook = res.body.webhook;
  return { webhook, path: new URL(webhook.url).pathname };
}

async function historico(cliente: Cliente, id: string) {
  const res = await request(app).get(`/api/form-webhooks/${id}/submissions`).set(cliente.auth).expect(200);
  return res.body as Array<{
    _id: string;
    email: string;
    name: string;
    status: string;
    reason: string;
    fields: Record<string, string>;
  }>;
}

describe('webhook de formulário: painel', () => {
  it('cria com URL própria e cada cliente só vê os seus', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const { webhook } = await criarWebhook(a);

    expect(webhook.url).toMatch(/\/api\/hooks\/forms\/[A-Za-z0-9_-]{32}$/);
    expect(webhook.templateName).toBe('Obrigado');

    const listaA = await request(app).get('/api/form-webhooks').set(a.auth).expect(200);
    const listaB = await request(app).get('/api/form-webhooks').set(b.auth).expect(200);
    expect(listaA.body).toHaveLength(1);
    expect(listaB.body).toHaveLength(0);
    await request(app).get(`/api/form-webhooks/${webhook.id}/submissions`).set(b.auth).expect(404);
  });

  it('não aceita template de outro cliente', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const doB = await criarTemplate(b.tenant._id);
    await request(app)
      .post('/api/form-webhooks/save')
      .set(a.auth)
      .send({ name: 'Orçamento', templateId: String(doB._id) })
      .expect(400);
  });

  it('usuário comum não gerencia webhooks', async () => {
    const comum = await criarCliente('Cliente A', 'user');
    await request(app).get('/api/form-webhooks').set(comum.auth).expect(403);
  });

  it('o token fica cifrado no banco', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook } = await criarWebhook(a);
    const cru = await FormWebhook.collection.findOne({});
    const token = webhook.url.split('/').pop();
    expect(cru?.token).not.toContain(token);
  });

  it('gerar nova URL desliga a anterior', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a);
    const res = await request(app).post(`/api/form-webhooks/${webhook.id}/regenerate`).set(a.auth).expect(200);
    const novo = new URL(res.body.webhook.url).pathname;

    await request(app).post(path).send({ email: 'ana@x.com' }).expect(404);
    await request(app).post(novo).send({ email: 'ana@x.com' }).expect(202);
  });
});

describe('webhook de formulário: recebimento', () => {
  it('recebe JSON, registra e enfileira o envio', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a);

    const res = await request(app)
      .post(path)
      .send({ nome: 'Ana', email: 'Ana@X.com', telefone: '11 99999-0000' })
      .expect(202);
    expect(res.body.ok).toBe(true);

    const [sub] = await historico(a, webhook.id);
    expect(sub).toMatchObject({ email: 'ana@x.com', name: 'Ana', status: 'queued' });
    expect(sub.fields.telefone).toBe('11 99999-0000');
    expect(await formEmailQueue.getJob(`form-${sub._id}`)).toBeTruthy();
  });

  it('aceita o formato do Elementor (urlencoded aninhado)', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a);

    await request(app)
      .post(path)
      .type('form')
      .send(
        'form[name]=Contato&fields[name][id]=name&fields[name][title]=Nome&fields[name][value]=Bruno' +
          '&fields[email][id]=email&fields[email][value]=bruno@x.com'
      )
      .expect(202);

    const [sub] = await historico(a, webhook.id);
    expect(sub).toMatchObject({ email: 'bruno@x.com', name: 'Bruno' });
  });

  it('aceita multipart e texto com JSON', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a);

    await request(app).post(path).field('email', 'cris@x.com').field('nome', 'Cris').expect(202);
    await request(app)
      .post(path)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ email: 'duda@x.com' }))
      .expect(202);

    const emails = (await historico(a, webhook.id)).map((s) => s.email).sort();
    expect(emails).toEqual(['cris@x.com', 'duda@x.com']);
  });

  it('URL errada e webhook pausado respondem igual, sem revelar nada', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a);

    const errada = await request(app)
      .post('/api/hooks/forms/tokenQueNaoExisteMesmoNaoExiste123')
      .send({ email: 'a@x.com' });
    await request(app)
      .post('/api/form-webhooks/save')
      .set(a.auth)
      .send({ id: webhook.id, name: webhook.name, templateId: webhook.templateId, isActive: false })
      .expect(200);
    const pausado = await request(app).post(path).send({ email: 'a@x.com' });

    expect(errada.status).toBe(404);
    expect(pausado.status).toBe(404);
    expect(pausado.body).toEqual(errada.body);
  });

  it('sem email válido a submissão é recusada e aparece no histórico', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a);

    const res = await request(app).post(path).send({ nome: 'Sem email', email: 'nao-e-email' }).expect(422);
    expect(res.body.error).toMatch(/email válido/);

    const [sub] = await historico(a, webhook.id);
    expect(sub).toMatchObject({ status: 'rejected' });
    expect(await formEmailQueue.getJob(`form-${sub._id}`)).toBeUndefined();
  });

  it('respeita o teto de envios por hora', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a, { hourlyLimit: 2 });

    await request(app).post(path).send({ email: 'um@x.com' }).expect(202);
    await request(app).post(path).send({ email: 'dois@x.com' }).expect(202);
    const res = await request(app).post(path).send({ email: 'tres@x.com' }).expect(429);

    expect(res.body.error).toMatch(/2 envios por hora/);
    const status = (await historico(a, webhook.id)).map((s) => s.status).sort();
    expect(status).toEqual(['queued', 'queued', 'rejected']);
  });

  it('o mesmo email reenviado em seguida não recebe duas vezes', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a);

    await request(app).post(path).send({ email: 'ana@x.com' }).expect(202);
    await request(app).post(path).send({ email: 'ANA@x.com' }).expect(202);

    expect(await historico(a, webhook.id)).toHaveLength(1);
  });

  it('robô que preenche o honeypot recebe 202 e nada é enviado', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a);

    await request(app).post(path).send({ email: 'bot@x.com', _gotcha: 'spam' }).expect(202);

    expect(await historico(a, webhook.id)).toHaveLength(0);
  });

  it('não guarda senha nem cartão enviados por engano', async () => {
    const a = await criarCliente('Cliente A');
    const { webhook, path } = await criarWebhook(a);

    await request(app).post(path).send({ email: 'ana@x.com', senha: 'segredo', numero_cartao: '4111' }).expect(202);

    const [sub] = await historico(a, webhook.id);
    expect(Object.keys(sub.fields)).toEqual(['email']);
  });

  it('formulário HTML sem JavaScript volta para a página de obrigado', async () => {
    const a = await criarCliente('Cliente A');
    const { path } = await criarWebhook(a, { redirectUrl: 'https://cliente.com.br/obrigado' });

    const res = await request(app)
      .post(path)
      .type('form')
      .set('Accept', 'text/html,application/xhtml+xml')
      .send('email=ana@x.com')
      .expect(303);

    expect(res.headers.location).toBe('https://cliente.com.br/obrigado?mmail=enviado');
  });

  describe('formulário HTML comum, sem página de obrigado', () => {
    const NAVEGADOR = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

    it('mostra uma página de confirmação em vez de JSON', async () => {
      const a = await criarCliente('Cliente A');
      const { webhook, path } = await criarWebhook(a);

      const res = await request(app)
        .post(path)
        .type('form')
        .set('Accept', NAVEGADOR)
        .set('Referer', 'https://cliente.com.br/contato')
        .send('nome=Ana&email=ana@x.com')
        .expect(200);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Recebemos seus dados');
      expect(res.text).toContain('href="https://cliente.com.br/contato"');
      const [sub] = await historico(a, webhook.id);
      expect(sub).toMatchObject({ email: 'ana@x.com', status: 'queued' });
    });

    it('recusa sem email explica em página, sem detalhes internos', async () => {
      const a = await criarCliente('Cliente A');
      const { path } = await criarWebhook(a);

      const res = await request(app).post(path).type('form').set('Accept', NAVEGADOR).send('nome=Ana').expect(422);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Confira o email informado');
    });

    it('URL inexistente responde com página, e o link de volta não aceita javascript:', async () => {
      const res = await request(app)
        .post('/api/hooks/forms/tokenQueNaoExisteMesmoNaoExiste123')
        .type('form')
        .set('Accept', NAVEGADOR)
        .set('Referer', 'javascript:alert(1)')
        .send('email=ana@x.com')
        .expect(404);

      expect(res.text).toContain('Formulário indisponível');
      expect(res.text).not.toContain('javascript:');
    });
  });

  it('pode ser chamado de qualquer site (CORS)', async () => {
    const a = await criarCliente('Cliente A');
    const { path } = await criarWebhook(a);

    const res = await request(app)
      .post(path)
      .set('Origin', 'https://site-do-cliente.com.br')
      .send({ email: 'ana@x.com' });

    expect(res.headers['access-control-allow-origin']).toBe('https://site-do-cliente.com.br');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('GET confirma que o webhook existe', async () => {
    const a = await criarCliente('Cliente A');
    const { path } = await criarWebhook(a);
    const res = await request(app).get(path).expect(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('webhook de formulário: envio', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function recebido(cliente: Cliente, corpo: Record<string, unknown>) {
    await runWithTenant(cliente.tenant._id, async () =>
      SmtpSettings.create({
        name: 'Próprio',
        host: 'smtp.cliente.com.br',
        port: 587,
        user: 'envio@cliente.com.br',
        password: 'senha',
        fromName: 'Cliente',
        fromEmail: 'contato@cliente.com.br',
        isDefault: true,
      })
    );
    const { webhook, path } = await criarWebhook(cliente);
    await request(app).post(path).send(corpo).expect(202);
    const [sub] = await historico(cliente, webhook.id);
    return { webhook, sub };
  }

  it('envia o template com os campos do formulário como variáveis', async () => {
    const a = await criarCliente('Cliente A');
    const send = vi.spyOn(emailService, 'send').mockResolvedValue({ messageId: 'msg-1' });
    const { webhook, sub } = await recebido(a, { nome: 'Ana', email: 'ana@x.com', telefone: '1199990000' });

    await runWithTenant(a.tenant._id, () => formWebhookService.deliver(sub._id));

    expect(send).toHaveBeenCalledTimes(1);
    const params = send.mock.calls[0][0];
    expect(params.to).toBe('ana@x.com');
    expect(params.data).toMatchObject({ name: 'Ana', telefone: '1199990000', email: 'ana@x.com' });
    expect(params.skipTracking).toBe(true);

    const [depois] = await historico(a, webhook.id);
    expect(depois).toMatchObject({ status: 'sent' });
    const lista = await request(app).get('/api/form-webhooks').set(a.auth);
    expect(lista.body[0].stats).toMatchObject({ received: 1, sent: 1 });
  });

  it('não envia para endereço com bounce registrado', async () => {
    const a = await criarCliente('Cliente A');
    const send = vi.spyOn(emailService, 'send').mockResolvedValue({ messageId: 'msg-1' });
    await runWithTenant(a.tenant._id, async () => Contact.create({ email: 'volta@x.com', status: 'bounced' }));
    const { webhook, sub } = await recebido(a, { email: 'volta@x.com' });

    await runWithTenant(a.tenant._id, () => formWebhookService.deliver(sub._id));

    expect(send).not.toHaveBeenCalled();
    const [depois] = await historico(a, webhook.id);
    expect(depois).toMatchObject({ status: 'failed' });
    expect(depois.reason).toMatch(/bounce/);
  });

  it('template apagado depois do recebimento vira falha explicada, sem envio', async () => {
    const a = await criarCliente('Cliente A');
    const send = vi.spyOn(emailService, 'send').mockResolvedValue({ messageId: 'msg-1' });
    const { webhook, sub } = await recebido(a, { email: 'ana@x.com' });
    await runWithTenant(a.tenant._id, async () => Template.deleteMany({}));

    await runWithTenant(a.tenant._id, () => formWebhookService.deliver(sub._id));

    expect(send).not.toHaveBeenCalled();
    const [depois] = await runWithTenant(a.tenant._id, async () =>
      FormSubmission.find({ webhookId: webhook.id }).lean()
    );
    expect(depois.reason).toMatch(/template/);
  });
});
