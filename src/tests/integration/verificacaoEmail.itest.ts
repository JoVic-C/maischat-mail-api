import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../app';
import { redisConnection } from '../../config/redis';
import { runWithTenant } from '../../config/tenantContext';
import Contact from '../../models/Contact';
import List from '../../models/List';
import VerificationJob from '../../models/VerificationJob';
import emailVerificationService from '../../services/emailVerification.service';
import { criarCliente } from './fabricas';

/** Dublê do provedor: o teste controla o que a EmailListVerify responde a cada etapa. */
const provedor = vi.hoisted(() => ({
  configured: true,
  uploads: [] as string[],
  progresso: { status: 'processing', progress: 40 } as { status: string; progress: number },
  resultados: [] as { email: string; result: string }[],
  apagadas: [] as string[],
  unitario: 'ok',
}));

vi.mock('../../services/emailListVerify.client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/emailListVerify.client')>();
  return {
    ...real,
    default: {
      get configured() {
        return provedor.configured;
      },
      verifyEmail: async () => provedor.unitario,
      uploadList: async (csv: string) => {
        provedor.uploads.push(csv);
        return `lista-${provedor.uploads.length}`;
      },
      getProgress: async () => provedor.progresso,
      downloadResults: async function* () {
        yield* provedor.resultados;
      },
      deleteList: async (id: string) => {
        provedor.apagadas.push(id);
      },
    },
  };
});

// As etapas rodam à mão no teste, na ordem, sem worker.
const enfileiradas = vi.hoisted(() => [] as { step: string; delayMs?: number }[]);
vi.mock('../../queue/verification.queue', () => ({
  enqueueVerificationStep: async (_t: string, _j: string, step: string, opts: { delayMs?: number } = {}) => {
    enfileiradas.push({ step, delayMs: opts.delayMs });
  },
}));

// Sem DNS de verdade: todo domínio "recebe email".
vi.mock('../../utils/emailHygiene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/emailHygiene')>()),
  emailDomainHasMail: async () => true,
}));

type Cliente = Awaited<ReturnType<typeof criarCliente>>;

async function listaCom(cliente: Cliente, emails: string[]) {
  return runWithTenant(cliente.tenant._id, async () => {
    const lista = await List.create({ name: `Lista ${Date.now()}` });
    await Contact.insertMany(emails.map((email) => ({ email, lists: [lista._id] })));
    return lista;
  });
}

async function cotaUsada(cliente: Cliente): Promise<number> {
  return runWithTenant(cliente.tenant._id, async () => (await emailVerificationService.getQuota()).used);
}

describe('verificação de emails com a EmailListVerify', () => {
  beforeEach(async () => {
    provedor.configured = true;
    provedor.uploads = [];
    provedor.progresso = { status: 'processing', progress: 40 };
    provedor.resultados = [];
    provedor.apagadas = [];
    provedor.unitario = 'ok';
    enfileiradas.length = 0;
    vi.stubEnv('EMAIL_VERIFY_MONTHLY_LIMIT', '100');
    const chaves = await redisConnection.keys('email-verify:*');
    if (chaves.length) await redisConnection.del(...chaves);
  });

  it('verifica a lista de ponta a ponta e grava o resultado em cada contato', async () => {
    const a = await criarCliente('Cliente A');
    const lista = await listaCom(a, ['ana@x.com', 'bruno@x.com', 'cris@x.com', 'duda@x.com']);

    const inicio = await request(app).post(`/api/lists/${lista._id}/verify`).set(a.auth).expect(202);
    expect(inicio.body.job.status).toBe('queued');
    expect(await cotaUsada(a)).toBe(4);

    const jobId = String(inicio.body.job._id);
    await runWithTenant(a.tenant._id, () => emailVerificationService.runStep(jobId, 'upload', 0));
    expect(provedor.uploads).toHaveLength(1);
    expect(provedor.uploads[0].split('\n').filter(Boolean).sort()).toEqual([
      'ana@x.com',
      'bruno@x.com',
      'cris@x.com',
      'duda@x.com',
      'email',
    ]);

    await runWithTenant(a.tenant._id, () => emailVerificationService.runStep(jobId, 'poll', 0));
    const andamento = await request(app).get(`/api/lists/${lista._id}/verification`).set(a.auth).expect(200);
    expect(andamento.body.job).toMatchObject({ status: 'verifying', progress: 40 });

    provedor.progresso = { status: 'finished', progress: 100 };
    await runWithTenant(a.tenant._id, () => emailVerificationService.runStep(jobId, 'poll', 0));
    provedor.resultados = [
      { email: 'ana@x.com', result: 'ok' },
      { email: 'bruno@x.com', result: 'email_disabled' },
      { email: 'cris@x.com', result: 'ok_for_all' },
      { email: 'duda@x.com', result: 'antispam_system' },
    ];
    await runWithTenant(a.tenant._id, () => emailVerificationService.runStep(jobId, 'apply', 0));

    const final = await request(app).get(`/api/lists/${lista._id}/verification`).set(a.auth).expect(200);
    expect(final.body.job).toMatchObject({
      status: 'done',
      total: 4,
      counters: { deliverable: 1, undeliverable: 1, risky: 1, unknown: 1 },
    });
    // O inconclusivo não é cobrado pelo provedor: volta para a cota.
    expect(await cotaUsada(a)).toBe(3);
    expect(provedor.apagadas).toEqual(['lista-1']);

    const contatos = await runWithTenant(a.tenant._id, async () => Contact.find({}).lean());
    const porEmail = Object.fromEntries(contatos.map((c) => [c.email, c.verification?.status]));
    expect(porEmail).toEqual({
      'ana@x.com': 'deliverable',
      'bruno@x.com': 'undeliverable',
      'cris@x.com': 'risky',
      'duda@x.com': 'unknown',
    });

    // Reprovados aparecem no filtro da tela de contatos.
    const filtro = await request(app)
      .get('/api/contacts')
      .query({ listId: String(lista._id), verification: 'undeliverable' })
      .set(a.auth)
      .expect(200);
    expect(filtro.body.contacts.map((c: { email: string }) => c.email)).toEqual(['bruno@x.com']);
  });

  it('não reenvia ao provedor quem foi verificado há pouco', async () => {
    const a = await criarCliente('Cliente A');
    const lista = await listaCom(a, ['ana@x.com', 'bruno@x.com']);
    await runWithTenant(a.tenant._id, async () => {
      await Contact.updateOne(
        { email: 'ana@x.com' },
        { verification: { status: 'deliverable', result: 'ok', checkedAt: new Date() } }
      );
    });

    const inicio = await request(app).post(`/api/lists/${lista._id}/verify`).set(a.auth).expect(202);
    await runWithTenant(a.tenant._id, () => emailVerificationService.runStep(String(inicio.body.job._id), 'upload', 0));

    expect(provedor.uploads[0]).toBe('email\nbruno@x.com\n');
    expect(await cotaUsada(a)).toBe(1);
  });

  it('lista toda verificada recentemente não gasta nada', async () => {
    const a = await criarCliente('Cliente A');
    const lista = await listaCom(a, ['ana@x.com']);
    await runWithTenant(a.tenant._id, async () => {
      await Contact.updateOne({}, { verification: { status: 'deliverable', result: 'ok', checkedAt: new Date() } });
    });

    const res = await request(app).post(`/api/lists/${lista._id}/verify`).set(a.auth).expect(400);
    expect(res.body.error).toMatch(/já foram verificados/);
  });

  it('recusa quando a cota mensal do cliente não cobre a lista', async () => {
    vi.stubEnv('EMAIL_VERIFY_MONTHLY_LIMIT', '2');
    const a = await criarCliente('Cliente A');
    const lista = await listaCom(a, ['ana@x.com', 'bruno@x.com', 'cris@x.com']);

    const res = await request(app).post(`/api/lists/${lista._id}/verify`).set(a.auth).expect(400);
    expect(res.body.error).toMatch(/Cota mensal/);
    expect(await cotaUsada(a)).toBe(0);
  });

  it('não deixa iniciar duas verificações da mesma lista', async () => {
    const a = await criarCliente('Cliente A');
    const lista = await listaCom(a, ['ana@x.com']);

    await request(app).post(`/api/lists/${lista._id}/verify`).set(a.auth).expect(202);
    await request(app).post(`/api/lists/${lista._id}/verify`).set(a.auth).expect(409);
  });

  it('só administradores gastam créditos', async () => {
    const usuario = await criarCliente('Cliente A', 'user');
    const lista = await listaCom(usuario, ['ana@x.com']);

    await request(app).post(`/api/lists/${lista._id}/verify`).set(usuario.auth).expect(403);
    // Acompanhar continua liberado.
    await request(app).get(`/api/lists/${lista._id}/verification`).set(usuario.auth).expect(200);
  });

  it('envio interrompido não é repetido às cegas: reenviar cobraria de novo', async () => {
    const a = await criarCliente('Cliente A');
    const lista = await listaCom(a, ['ana@x.com']);
    const inicio = await request(app).post(`/api/lists/${lista._id}/verify`).set(a.auth).expect(202);
    const jobId = String(inicio.body.job._id);
    await runWithTenant(a.tenant._id, async () => {
      await VerificationJob.updateOne({ _id: jobId }, { status: 'uploading' });
    });

    await runWithTenant(a.tenant._id, () => emailVerificationService.runStep(jobId, 'upload', 0));

    expect(provedor.uploads).toHaveLength(0);
    const job = await runWithTenant(a.tenant._id, async () => VerificationJob.findById(jobId).lean());
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/interrompida/);
  });

  it('lista com erro no provedor falha e devolve a cota', async () => {
    const a = await criarCliente('Cliente A');
    const lista = await listaCom(a, ['ana@x.com', 'bruno@x.com']);
    const inicio = await request(app).post(`/api/lists/${lista._id}/verify`).set(a.auth).expect(202);
    const jobId = String(inicio.body.job._id);

    await runWithTenant(a.tenant._id, () => emailVerificationService.runStep(jobId, 'upload', 0));
    provedor.progresso = { status: 'error', progress: 0 };
    await runWithTenant(a.tenant._id, () => emailVerificationService.runStep(jobId, 'poll', 0));

    const job = await runWithTenant(a.tenant._id, async () => VerificationJob.findById(jobId).lean());
    expect(job?.status).toBe('failed');
    expect(await cotaUsada(a)).toBe(0);
  });

  it('um cliente não vê nem inicia a verificação da lista de outro', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const listaDeA = await listaCom(a, ['ana@x.com']);

    await request(app).post(`/api/lists/${listaDeA._id}/verify`).set(b.auth).expect(404);
  });

  it('cadastro manual recusa caixa postal inexistente e guarda a verificação das válidas', async () => {
    const a = await criarCliente('Cliente A');

    provedor.unitario = 'email_disabled';
    const recusado = await request(app).post('/api/contacts').set(a.auth).send({ email: 'sumiu@x.com' }).expect(400);
    expect(JSON.stringify(recusado.body)).toMatch(/não existe ou está desativada/);

    provedor.unitario = 'ok';
    await request(app).post('/api/contacts').set(a.auth).send({ email: 'ana@x.com' }).expect(201);
    const contato = await runWithTenant(a.tenant._id, async () => Contact.findOne({ email: 'ana@x.com' }).lean());
    expect(contato?.verification).toMatchObject({ status: 'deliverable', result: 'ok' });
  });

  it('sem chave configurada, o cadastro manual segue só com a checagem de domínio', async () => {
    provedor.configured = false;
    const a = await criarCliente('Cliente A');

    await request(app).post('/api/contacts').set(a.auth).send({ email: 'ana@x.com' }).expect(201);
    const contato = await runWithTenant(a.tenant._id, async () => Contact.findOne({ email: 'ana@x.com' }).lean());
    expect(contato?.verification).toBeUndefined();
  });
});
