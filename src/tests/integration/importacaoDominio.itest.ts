import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithTenant } from '../../config/tenantContext';
import Contact from '../../models/Contact';
import contactImportService, { ensureImportDir, IMPORT_DIR, safeUnlink } from '../../services/contactImport.service';
import { criarCliente } from './fabricas';

/** Dublê da checagem de domínio: o teste decide o veredito de cada domínio e conta as consultas. */
const dominios = vi.hoisted(() => ({
  veredito: {
    'mailinator.com': 'disposable',
    'estacionado.com': 'no-mail',
  } as Record<string, string>,
  consultas: [] as string[],
}));

vi.mock('../../services/domainCheck.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/domainCheck.service')>();
  const check = async (dominio: string) => {
    dominios.consultas.push(dominio);
    return dominios.veredito[dominio] ?? 'ok';
  };
  return {
    ...original,
    default: { check, checkEmail: (email: string) => check(email.split('@')[1] ?? '') },
  };
});

describe('checagem de domínio na importação', () => {
  let arquivos: string[] = [];

  afterEach(() => {
    for (const arquivo of arquivos) safeUnlink(arquivo);
    arquivos = [];
    dominios.consultas = [];
  });

  it('descartável entra sinalizado, domínio sem email é recusado e cada domínio é consultado uma vez', async () => {
    const a = await criarCliente('Cliente A');
    ensureImportDir();
    const arquivo = path.join(IMPORT_DIR, `dominio-${Date.now()}.csv`);
    fs.writeFileSync(
      arquivo,
      ['email', 'ana@empresa.com.br', 'bruno@empresa.com.br', 'temp@mailinator.com', 'cris@estacionado.com', ''].join(
        '\n'
      )
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
    expect(validado.counters).toMatchObject({ new: 3, invalid: 1 });
    expect(dominios.consultas.sort()).toEqual(['empresa.com.br', 'estacionado.com', 'mailinator.com']);

    await runWithTenant(a.tenant._id, async () => {
      await contactImportService.confirm(job.id, []);
      await contactImportService.runImport(job.id);
    });

    const contatos = await runWithTenant(a.tenant._id, async () =>
      Contact.find().select('email verification').sort({ email: 1 }).lean()
    );
    expect(contatos.map((c) => c.email)).toEqual(['ana@empresa.com.br', 'bruno@empresa.com.br', 'temp@mailinator.com']);
    expect(contatos.find((c) => c.email === 'temp@mailinator.com')?.verification).toMatchObject({
      status: 'risky',
      result: 'disposable',
    });
    expect(contatos.find((c) => c.email === 'ana@empresa.com.br')?.verification).toBeUndefined();
  });

  it('contato que já está na base não gasta consulta de domínio', async () => {
    const a = await criarCliente('Cliente A');
    await runWithTenant(a.tenant._id, () => Contact.create({ email: 'ana@antigo.com' }));
    ensureImportDir();
    const arquivo = path.join(IMPORT_DIR, `dominio-existente-${Date.now()}.csv`);
    fs.writeFileSync(arquivo, 'email\nana@antigo.com\n');

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
    expect(dominios.consultas).toEqual([]);
  });
});
