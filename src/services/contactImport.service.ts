/**
 * Importação de contatos em massa. O arquivo nunca é carregado inteiro em memória: a
 * validação percorre-o em lotes e grava o veredito em dois NDJSON (aceitos e recusados),
 * e a confirmação lê o de aceitos.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Types } from 'mongoose';
import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import ImportJob, { type IImportJob, type ImportCounters, type ImportJobDocument } from '../models/ImportJob';
import { inBatches } from '../utils/csvStream';
import { buildInvalidExcel, type InvalidRow } from '../utils/excel';
import { logger, logSideEffect } from '../utils/logger';
import { streamSheetRows } from '../utils/sheetStream';
import contactService, { type ClassifiedRow, type ValidatedRow } from './contact.service';

/** Fora de `uploads/`, que é servido sem autenticação: o arquivo é a base de contatos do cliente. */
export const IMPORT_DIR = process.env.IMPORT_DIR || 'data/imports';

const VALIDATE_BATCH = 200;
const IMPORT_BATCH = 500;
/** A cada quantas linhas o progresso vai para o banco e o cancelamento é checado. */
const FLUSH_EVERY = 2000;
const SAMPLE_SIZE = 200;
/** Acima disto o relatório de recusados sai em CSV, porque o .xlsx é montado em memória. */
const XLSX_MAX_ROWS = 20_000;
const RETENTION_MS = 48 * 60 * 60 * 1000;

export function ensureImportDir(): void {
  if (!fs.existsSync(IMPORT_DIR)) fs.mkdirSync(IMPORT_DIR, { recursive: true });
  // Volume montado com outro dono: sem esta checagem a falha só aparece na gravação.
  fs.accessSync(IMPORT_DIR, fs.constants.W_OK);
}

function writeLine(stream: fs.WriteStream, line: string): Promise<void> {
  if (stream.write(line)) return Promise.resolve();
  return new Promise((resolve) => stream.once('drain', () => resolve()));
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

function emptyCounters(): ImportCounters {
  return { rows: 0, new: 0, addToList: 0, inList: 0, already: 0, invalid: 0 };
}

export function safeUnlink(filePath: string): void {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    logSideEffect('contactImport.unlink', err, { filePath });
  }
}

export interface CreateImportInput {
  filePath: string;
  originalName: string;
  sizeBytes: number;
  listIds: string[];
  userId: string;
}

interface SampleRow {
  email: string;
  kind: string;
  reason?: string;
}

export class ContactImportService {
  async create(input: CreateImportInput): Promise<ImportJobDocument> {
    const job = await ImportJob.create({
      createdBy: new Types.ObjectId(input.userId),
      originalName: input.originalName,
      sizeBytes: input.sizeBytes,
      sourcePath: input.filePath,
      listIds: input.listIds.map((id) => new Types.ObjectId(id)),
      status: 'uploaded',
      counters: emptyCounters(),
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });

    job.validPath = path.join(IMPORT_DIR, `${job.id}.valid.ndjson`);
    job.invalidPath = path.join(IMPORT_DIR, `${job.id}.invalid.ndjson`);
    await job.save();
    return job;
  }

  async getById(id: string): Promise<ImportJobDocument> {
    const job = await ImportJob.findById(id);
    if (!job) throw new NotFoundError('Importação não encontrada.');
    return job;
  }

  /** Status para a tela, sem os caminhos de arquivo. */
  async getStatus(id: string): Promise<Record<string, unknown>> {
    const job = await this.getById(id);
    const plain = job.toObject() as IImportJob & { _id: Types.ObjectId };
    const { sourcePath, validPath, invalidPath, ...rest } = plain;
    return { ...rest, id: job.id };
  }

  async listOpen(limit = 5): Promise<{ id: string; status: string; originalName: string; createdAt: Date }[]> {
    const jobs = await ImportJob.find({ status: { $in: ['uploaded', 'validating', 'validated', 'importing'] } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('status originalName createdAt')
      .lean<{ _id: Types.ObjectId; status: string; originalName: string; createdAt: Date }[]>();

    return jobs.map((j) => ({
      id: String(j._id),
      status: j.status,
      originalName: j.originalName,
      createdAt: j.createdAt,
    }));
  }

  async cancel(id: string): Promise<void> {
    const job = await this.getById(id);
    if (job.status === 'done' || job.status === 'failed') return;
    job.status = 'canceled';
    job.finishedAt = new Date();
    await job.save();
  }

  async runValidation(jobId: string): Promise<void> {
    const job = await this.getById(jobId);
    if (job.status !== 'uploaded') return; // reentrega da fila sobre um job já processado

    job.status = 'validating';
    job.startedAt = new Date();
    job.counters = emptyCounters();
    job.sample = [];
    await job.save();

    const listIds = job.listIds.map(String);
    const ctx = { mxCache: new Map<string, boolean>(), seen: new Set<string>() };
    const counters = emptyCounters();
    const sample: SampleRow[] = [];

    const validOut = fs.createWriteStream(job.validPath, { flags: 'w' });
    const invalidOut = fs.createWriteStream(job.invalidPath, { flags: 'w' });

    try {
      let sinceFlush = 0;

      for await (const batch of inBatches(streamSheetRows(job.sourcePath), VALIDATE_BATCH)) {
        const classified = await contactService.classifyBatch(batch, listIds, ctx);

        for (const row of classified) {
          counters.rows++;
          this.tally(counters, row);
          if (sample.length < SAMPLE_SIZE) {
            sample.push({ email: row.email || '(vazio)', kind: row.kind, reason: row.reason });
          }
          await this.persistRow(row, validOut, invalidOut);
        }

        sinceFlush += batch.length;
        if (sinceFlush >= FLUSH_EVERY) {
          sinceFlush = 0;
          const stillRunning = await this.flush(job.id, counters, sample);
          if (!stillRunning) return;
        }
      }

      await ImportJob.updateOne({ _id: job.id }, { counters, sample, status: 'validated', finishedAt: new Date() });
      logger.info(`✓ Validação da importação ${job.id}: ${counters.rows} linha(s).`);
    } finally {
      await closeStream(validOut);
      await closeStream(invalidOut);
    }
  }

  async runImport(jobId: string): Promise<void> {
    const job = await this.getById(jobId);
    if (job.status !== 'importing') return;

    const listIds = job.listIds.map(String);
    let imported = 0;
    let skipped = 0;
    let sinceFlush = 0;

    for await (const batch of inBatches(this.readNdjson<ValidatedRow>(job.validPath), IMPORT_BATCH)) {
      const result = await contactService.importRows(batch, listIds);
      imported += result.imported;
      skipped += result.skipped;

      sinceFlush += batch.length;
      if (sinceFlush >= FLUSH_EVERY) {
        sinceFlush = 0;
        const fresh = await ImportJob.findById(job.id).select('status').lean<{ status: string } | null>();
        if (fresh?.status === 'canceled') {
          // Cancelar não desfaz o que já entrou; o contador precisa refletir isso.
          await ImportJob.updateOne({ _id: job.id }, { imported, skipped, finishedAt: new Date() });
          await contactService.syncCounts(listIds);
          return;
        }
        await ImportJob.updateOne({ _id: job.id }, { imported, skipped });
      }
    }

    await contactService.syncCounts(listIds);
    await ImportJob.updateOne({ _id: job.id }, { imported, skipped, status: 'done', finishedAt: new Date() });
    logger.info(`✓ Importação ${job.id}: ${imported} gravado(s), ${skipped} pulado(s).`);
  }

  /**
   * A lista de destino tem que ser a da validação: a classificação de quem já existe
   * depende dela, e importar com outra gravaria um resultado que ninguém conferiu.
   */
  async confirm(id: string, listIds: string[]): Promise<ImportJobDocument> {
    const job = await this.getById(id);
    if (job.status !== 'validated') {
      throw new ConflictError(`Importação não está pronta para confirmar (situação: ${job.status}).`);
    }

    const validated = job.listIds.map(String).sort();
    const requested = [...new Set(listIds)].sort();
    if (validated.join(',') !== requested.join(',')) {
      throw new ConflictError('A lista de destino mudou desde a validação. Valide novamente antes de importar.');
    }
    if (job.counters.new + job.counters.addToList === 0) {
      throw new BadRequestError('Nenhum contato para importar.');
    }

    job.status = 'importing';
    job.imported = 0;
    job.skipped = 0;
    job.finishedAt = null;
    await job.save();
    return job;
  }

  async buildInvalidReport(id: string): Promise<{ format: 'xlsx' | 'csv'; buffer: Buffer }> {
    const job = await this.getById(id);
    if (!job.counters.invalid) throw new BadRequestError('Nenhum contato recusado nesta importação.');

    if (job.counters.invalid > XLSX_MAX_ROWS) {
      const lines = ['Email;Nome;Motivo'];
      for await (const row of this.readNdjson<InvalidRow>(job.invalidPath)) {
        lines.push([row.email, row.name, row.reason].map((v) => this.csvCell(v)).join(';'));
      }
      // BOM para o Excel abrir em UTF-8.
      return { format: 'csv', buffer: Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8') };
    }

    const rows: InvalidRow[] = [];
    for await (const row of this.readNdjson<InvalidRow>(job.invalidPath)) rows.push(row);
    return { format: 'xlsx', buffer: await buildInvalidExcel(rows) };
  }

  /** Roda em modo system, atravessando clientes. */
  async cleanupExpired(): Promise<number> {
    const expired = await ImportJob.find({ expiresAt: { $lt: new Date() } })
      .select('sourcePath validPath invalidPath')
      .lean<{ _id: Types.ObjectId; sourcePath: string; validPath: string; invalidPath: string }[]>();
    if (!expired.length) return 0;

    for (const job of expired) {
      safeUnlink(job.sourcePath);
      safeUnlink(job.validPath);
      safeUnlink(job.invalidPath);
    }
    await ImportJob.deleteMany({ _id: { $in: expired.map((j) => j._id) } });
    logger.info(`🧹 ${expired.length} importação(ões) expirada(s) removida(s).`);
    return expired.length;
  }

  async markFailed(jobId: string, message: string): Promise<void> {
    await ImportJob.updateOne({ _id: jobId }, { status: 'failed', error: message, finishedAt: new Date() });
  }

  private csvCell(value: unknown): string {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  private tally(counters: ImportCounters, row: ClassifiedRow): void {
    switch (row.kind) {
      case 'new':
        counters.new++;
        break;
      case 'add-to-list':
        counters.addToList++;
        break;
      case 'in-list':
        counters.inList++;
        break;
      case 'already':
        counters.already++;
        break;
      default:
        counters.invalid++;
    }
  }

  private async persistRow(row: ClassifiedRow, validOut: fs.WriteStream, invalidOut: fs.WriteStream): Promise<void> {
    if (row.kind === 'new' || row.kind === 'add-to-list') {
      const payload: ValidatedRow = {
        email: row.email,
        name: row.name,
        phone: row.phone,
        company: row.company,
        metadata: row.metadata,
      };
      await writeLine(validOut, `${JSON.stringify(payload)}\n`);
      return;
    }
    if (row.kind === 'invalid') {
      const payload: InvalidRow = { email: row.email || '(vazio)', name: row.name, reason: row.reason ?? 'Inválido' };
      await writeLine(invalidOut, `${JSON.stringify(payload)}\n`);
    }
  }

  /**
   * Grava o progresso e devolve `false` se o job foi cancelado. O status é relido do
   * banco porque o cancelamento chega por outra requisição.
   */
  private async flush(jobId: string, counters: ImportCounters, sample: SampleRow[]): Promise<boolean> {
    const fresh = await ImportJob.findById(jobId).select('status').lean<{ status: string } | null>();
    if (!fresh || fresh.status === 'canceled') return false;

    await ImportJob.updateOne({ _id: jobId }, { counters, sample });
    return true;
  }

  private async *readNdjson<T>(filePath: string): AsyncGenerator<T> {
    if (!filePath || !fs.existsSync(filePath)) return;
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of rl as AsyncIterable<string>) {
        if (!line.trim()) continue;
        yield JSON.parse(line) as T;
      }
    } finally {
      rl.close();
      input.destroy();
    }
  }
}

export default new ContactImportService();
