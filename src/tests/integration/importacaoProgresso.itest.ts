import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithTenant } from '../../config/tenantContext';
import ImportJob from '../../models/ImportJob';
import contactImportService, { ensureImportDir, IMPORT_DIR, safeUnlink } from '../../services/contactImport.service';
import { criarCliente } from './fabricas';

// Sem DNS de verdade nos testes: todo domínio "recebe email".
vi.mock('../../utils/emailHygiene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/emailHygiene')>()),
  domainHasMail: async () => true,
}));

const LINHAS = 1000;

async function importacaoDe(linhas: number) {
  const a = await criarCliente('Cliente A');
  ensureImportDir();
  const arquivo = path.join(IMPORT_DIR, `progresso-${Date.now()}.csv`);
  const emails = Array.from({ length: linhas }, (_, i) => `contato${i}@exemplo.com.br`);
  fs.writeFileSync(arquivo, `email\n${emails.join('\n')}\n`);

  const job = await runWithTenant(a.tenant._id, () =>
    contactImportService.create({
      filePath: arquivo,
      originalName: 'base.csv',
      sizeBytes: fs.statSync(arquivo).size,
      listIds: [],
      userId: String(a.user._id),
    })
  );
  return { a, job, arquivos: [arquivo, job.validPath, job.invalidPath] };
}

/**
 * Registra a contagem no instante de cada gravação. O serviço reaproveita o mesmo objeto
 * `counters`; ler os argumentos do espião depois mostraria só o valor final.
 */
function espionarGravacoes(): number[] {
  const gravadas: number[] = [];
  const original = ImportJob.updateOne.bind(ImportJob) as (...args: unknown[]) => unknown;
  vi.spyOn(ImportJob, 'updateOne').mockImplementation(((...args: unknown[]) => {
    const rows = (args[1] as { counters?: { rows?: number } } | undefined)?.counters?.rows;
    if (typeof rows === 'number') gravadas.push(rows);
    return original(...args);
  }) as unknown as typeof ImportJob.updateOne);
  return gravadas;
}

describe('progresso da validação de importação', () => {
  const original = process.env.IMPORT_PROGRESS_MS;
  let arquivos: string[] = [];

  afterEach(() => {
    if (original === undefined) delete process.env.IMPORT_PROGRESS_MS;
    else process.env.IMPORT_PROGRESS_MS = original;
    for (const arquivo of arquivos) safeUnlink(arquivo);
    arquivos = [];
  });

  it('grava a contagem ao longo do processo, não em blocos de 2.000 linhas', async () => {
    process.env.IMPORT_PROGRESS_MS = '0';
    const { a, job, arquivos: gerados } = await importacaoDe(LINHAS);
    arquivos = gerados;
    const gravadas = espionarGravacoes();

    await runWithTenant(a.tenant._id, () => contactImportService.runValidation(job.id));

    expect(gravadas.at(-1)).toBe(LINHAS);
    const intermediarias = gravadas.slice(0, -1);
    expect(intermediarias.length).toBeGreaterThanOrEqual(3);
    expect(intermediarias[0]).toBeLessThan(LINHAS);
    expect(intermediarias.every((rows) => rows % 2000 !== 0)).toBe(true);
  });

  it('com o intervalo padrão, uma base pequena não gera gravações a cada lote', async () => {
    delete process.env.IMPORT_PROGRESS_MS;
    const { a, job, arquivos: gerados } = await importacaoDe(400);
    arquivos = gerados;
    const gravadas = espionarGravacoes();

    await runWithTenant(a.tenant._id, () => contactImportService.runValidation(job.id));

    const final = await runWithTenant(a.tenant._id, async () => ImportJob.findById(job.id).lean());
    expect(final?.status).toBe('validated');
    expect(final?.counters.rows).toBe(400);
    expect(gravadas.length).toBeLessThanOrEqual(2);
  });

  it('cancelar durante a validação é percebido na próxima gravação de progresso', async () => {
    process.env.IMPORT_PROGRESS_MS = '0';
    const { a, job, arquivos: gerados } = await importacaoDe(LINHAS);
    arquivos = gerados;
    await runWithTenant(a.tenant._id, async () => {
      await contactImportService.cancel(job.id);
      await ImportJob.updateOne({ _id: job.id }, { status: 'uploaded' });
    });

    const original = ImportJob.findById.bind(ImportJob);
    let consultas = 0;
    vi.spyOn(ImportJob, 'findById').mockImplementation(((id: unknown) => {
      consultas++;
      // Da segunda leitura em diante o job aparece cancelado, como se viesse de outra aba.
      if (consultas === 2) void ImportJob.updateOne({ _id: job.id }, { status: 'canceled' }).exec();
      return original(id as string);
    }) as typeof ImportJob.findById);

    await runWithTenant(a.tenant._id, () => contactImportService.runValidation(job.id));

    const final = await runWithTenant(a.tenant._id, async () => ImportJob.findById(job.id).lean());
    expect(final?.status).toBe('canceled');
    expect(final?.counters.rows ?? 0).toBeLessThan(LINHAS);
  });
});
