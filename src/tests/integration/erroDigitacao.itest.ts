import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../../app';
import { runWithTenant } from '../../config/tenantContext';
import AcceptedDomain from '../../models/AcceptedDomain';
import Contact from '../../models/Contact';
import contactImportService, { ensureImportDir, IMPORT_DIR, safeUnlink } from '../../services/contactImport.service';
import { criarCliente } from './fabricas';

/** Dublê da checagem de domínio: conta quem foi consultado. Nada de DNS ou provedor real. */
const dominios = vi.hoisted(() => ({ consultas: [] as string[] }));

vi.mock('../../services/domainCheck.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/domainCheck.service')>();
  const check = async (dominio: string) => {
    dominios.consultas.push(dominio);
    return 'ok';
  };
  return { ...original, default: { check, checkEmail: (email: string) => check(email.split('@')[1] ?? '') } };
});

// A correção confere se o domínio de destino recebe email; aqui sem DNS de verdade.
vi.mock('../../utils/emailHygiene', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/emailHygiene')>();
  return { ...original, dnsAcceptsMail: async (dominio: string) => dominio !== 'nao-recebe.com' };
});

type Cliente = Awaited<ReturnType<typeof criarCliente>>;

async function contatos(cliente: Cliente) {
  return runWithTenant(cliente.tenant._id, async () =>
    Contact.find().select('email verification').sort({ email: 1 }).lean()
  );
}

async function semear(cliente: Cliente, emails: string[]) {
  await runWithTenant(cliente.tenant._id, async () => {
    await Contact.insertMany(emails.map((email) => ({ email })));
  });
}

describe('erro de digitação na importação', () => {
  let arquivos: string[] = [];

  afterEach(() => {
    for (const arquivo of arquivos) safeUnlink(arquivo);
    arquivos = [];
    dominios.consultas = [];
  });

  it('suspeito entra marcado com a sugestão e não gasta consulta de domínio', async () => {
    const a = await criarCliente('Cliente A');
    ensureImportDir();
    const arquivo = path.join(IMPORT_DIR, `digitacao-${Date.now()}.csv`);
    fs.writeFileSync(
      arquivo,
      ['email', 'ana@gail.com', 'bia@gmail.con', 'caio@hotmail.com.br', 'davi@iclou.com'].join('\n')
    );

    const job = await runWithTenant(a.tenant._id, () =>
      contactImportService.create({
        filePath: arquivo,
        originalName: 'base.csv',
        sizeBytes: fs.statSync(arquivo).size,
        listIds: [],
        userId: String(a.user._id),
      })
    );
    arquivos = [arquivo, job.validPath, job.invalidPath];

    await runWithTenant(a.tenant._id, () => contactImportService.runValidation(job.id));
    const validado = await runWithTenant(a.tenant._id, () => contactImportService.getById(job.id));
    expect(validado.counters).toMatchObject({ new: 4, typo: 3, invalid: 0 });
    // Só o domínio sem suspeita foi à checagem (que gasta crédito).
    expect(dominios.consultas).toEqual(['hotmail.com.br']);

    await runWithTenant(a.tenant._id, async () => {
      await contactImportService.confirm(job.id, []);
      await contactImportService.runImport(job.id);
    });

    const gravados = await contatos(a);
    const por = (email: string) => gravados.find((c) => c.email === email)?.verification;
    expect(por('ana@gail.com')).toMatchObject({
      status: 'undeliverable',
      result: 'typo_suspected',
      suggestion: 'gmail.com',
    });
    expect(por('bia@gmail.con')).toMatchObject({ result: 'typo_suspected', suggestion: 'gmail.com' });
    expect(por('davi@iclou.com')).toMatchObject({ result: 'typo_suspected', suggestion: 'icloud.com' });
    expect(por('caio@hotmail.com.br')).toBeUndefined();
  });
});

describe('erro de digitação no cadastro manual', () => {
  afterEach(() => {
    dominios.consultas = [];
  });

  it('a sugestão avulsa responde para qualquer papel', async () => {
    const comum = await criarCliente('Cliente A', 'user');
    const res = await request(app)
      .get('/api/contacts/email-suggestion')
      .query({ email: 'Joao.Silva@gmaail.com' })
      .set(comum.auth)
      .expect(200);
    expect(res.body).toEqual({ suggestion: 'joao.silva@gmail.com' });

    const ok = await request(app)
      .get('/api/contacts/email-suggestion')
      .query({ email: 'ana@gmail.com' })
      .set(comum.auth)
      .expect(200);
    expect(ok.body).toEqual({ suggestion: null });
  });

  it('salvar sem confirmar marca o contato; com keepEmail segue a checagem normal', async () => {
    const a = await criarCliente('Cliente A');

    const marcado = await request(app).post('/api/contacts').set(a.auth).send({ email: 'ana@gail.com' }).expect(201);
    expect(marcado.body.contact.verification).toMatchObject({ result: 'typo_suspected', suggestion: 'gmail.com' });
    expect(dominios.consultas).toEqual([]);

    const mantido = await request(app)
      .post('/api/contacts')
      .set(a.auth)
      .send({ email: 'bia@cloud.com', keepEmail: true })
      .expect(201);
    expect(mantido.body.contact.verification ?? null).toBeNull();
    expect(dominios.consultas).toEqual(['cloud.com']);
  });

  it('editar o email para um domínio suspeito também marca', async () => {
    const a = await criarCliente('Cliente A');
    const criado = await request(app).post('/api/contacts').set(a.auth).send({ email: 'ana@gmail.com' }).expect(201);

    const editado = await request(app)
      .put(`/api/contacts/${criado.body.contact._id}`)
      .set(a.auth)
      .send({ email: 'ana@hotmial.com' })
      .expect(200);
    expect(editado.body.contact.verification).toMatchObject({ result: 'typo_suspected', suggestion: 'hotmail.com' });
  });
});

describe('revisão de domínios suspeitos', () => {
  it('lista os suspeitos com a quantidade, inclusive pela base do cliente', async () => {
    const a = await criarCliente('Cliente A');
    await semear(a, [
      ...Array.from({ length: 12 }, (_, i) => `p${i}@maischat.com.br`),
      'erro@maischta.com.br',
      'a@iclou.com',
      'b@iclou.com',
      'c@gail.com',
      'd@gmail.com',
    ]);

    const res = await request(app).get('/api/contacts/typo-domains').set(a.auth).expect(200);
    expect(res.body.domains).toEqual([
      { domain: 'iclou.com', count: 2, suggestion: 'icloud.com' },
      { domain: 'gail.com', count: 1, suggestion: 'gmail.com' },
      { domain: 'maischta.com.br', count: 1, suggestion: 'maischat.com.br' },
    ]);
  });

  it('corrigir troca o domínio, limpa a marcação e conta os conflitos', async () => {
    const a = await criarCliente('Cliente A');
    await runWithTenant(a.tenant._id, async () => {
      await Contact.create({
        email: 'ana@gail.com',
        verification: {
          status: 'undeliverable',
          result: 'typo_suspected',
          suggestion: 'gmail.com',
          checkedAt: new Date(),
        },
      });
      await Contact.create({ email: 'bia@gail.com' });
      await Contact.create({ email: 'bia@gmail.com', name: 'Já existia' });
    });

    const res = await request(app)
      .post('/api/contacts/typo-domains/fix')
      .set(a.auth)
      .send({ from: 'gail.com', to: 'gmail.com' })
      .expect(200);
    expect(res.body).toMatchObject({ fixed: 1, conflicts: 1 });

    const depois = await contatos(a);
    expect(depois.map((c) => c.email)).toEqual(['ana@gmail.com', 'bia@gail.com', 'bia@gmail.com']);
    expect(depois.find((c) => c.email === 'ana@gmail.com')?.verification ?? null).toBeNull();
  });

  it('corrigir recusa domínio que não é suspeito e destino que não recebe email', async () => {
    const a = await criarCliente('Cliente A');
    await semear(a, ['ana@gmail.com', 'bia@gail.com']);

    await request(app)
      .post('/api/contacts/typo-domains/fix')
      .set(a.auth)
      .send({ from: 'gmail.com', to: 'outro.com' })
      .expect(400);
    const destino = await request(app)
      .post('/api/contacts/typo-domains/fix')
      .set(a.auth)
      .send({ from: 'gail.com', to: 'nao-recebe.com' })
      .expect(400);
    expect(destino.body.errors?.[0]).toMatchObject({ field: 'to' });

    expect((await contatos(a)).map((c) => c.email)).toEqual(['ana@gmail.com', 'bia@gail.com']);
  });

  it('manter aceita o domínio, libera os contatos e ele sai da revisão', async () => {
    const a = await criarCliente('Cliente A');
    await runWithTenant(a.tenant._id, async () => {
      await Contact.create({
        email: 'ana@cloud.com',
        verification: {
          status: 'undeliverable',
          result: 'typo_suspected',
          suggestion: 'icloud.com',
          checkedAt: new Date(),
        },
      });
    });

    const res = await request(app)
      .post('/api/contacts/typo-domains/accept')
      .set(a.auth)
      .send({ domain: 'cloud.com' })
      .expect(200);
    expect(res.body).toMatchObject({ released: 1 });

    expect((await contatos(a))[0].verification ?? null).toBeNull();
    const lista = await request(app).get('/api/contacts/typo-domains').set(a.auth).expect(200);
    expect(lista.body.domains).toEqual([]);

    const sugestao = await request(app)
      .get('/api/contacts/email-suggestion')
      .query({ email: 'bia@cloud.com' })
      .set(a.auth)
      .expect(200);
    expect(sugestao.body.suggestion).toBeNull();
  });

  it('usuário comum não revisa domínios', async () => {
    const comum = await criarCliente('Cliente A', 'user');
    await request(app).get('/api/contacts/typo-domains').set(comum.auth).expect(403);
    await request(app)
      .post('/api/contacts/typo-domains/fix')
      .set(comum.auth)
      .send({ from: 'gail.com', to: 'gmail.com' })
      .expect(403);
    await request(app)
      .post('/api/contacts/typo-domains/accept')
      .set(comum.auth)
      .send({ domain: 'gail.com' })
      .expect(403);
  });

  it('cada cliente revisa e altera só a própria base', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    await semear(a, ['ana@gail.com', 'x@cloud.com']);
    await semear(b, ['bia@gail.com', 'y@cloud.com']);

    await request(app).post('/api/contacts/typo-domains/accept').set(a.auth).send({ domain: 'cloud.com' }).expect(200);
    await request(app)
      .post('/api/contacts/typo-domains/fix')
      .set(a.auth)
      .send({ from: 'gail.com', to: 'gmail.com' })
      .expect(200);

    expect((await contatos(b)).map((c) => c.email)).toEqual(['bia@gail.com', 'y@cloud.com']);
    const listaB = await request(app).get('/api/contacts/typo-domains').set(b.auth).expect(200);
    expect(listaB.body.domains.map((d: { domain: string }) => d.domain).sort()).toEqual(['cloud.com', 'gail.com']);
    expect(await runWithTenant(b.tenant._id, async () => await AcceptedDomain.countDocuments())).toBe(0);
  });
});
