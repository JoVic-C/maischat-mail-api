/**
 * Cliente HTTP da EmailListVerify (https://api.emaillistverify.com/api-doc). Só fala com a
 * API; o que fazer com cada resultado é decidido em `emailVerification.service`.
 */
import readline from 'node:readline';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { detectDelimiter, splitLine } from '../utils/csv';

export type ProviderErrorKind = 'auth' | 'credit' | 'rate' | 'unavailable' | 'rejected';

/** `rate` e `unavailable` são passageiros; os demais exigem ação de alguém. */
export class EmailVerifyProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderErrorKind
  ) {
    super(message);
    this.name = 'EmailVerifyProviderError';
  }

  get transient(): boolean {
    return this.kind === 'rate' || this.kind === 'unavailable';
  }
}

export type MaillistStatus = 'uploaded' | 'processing' | 'finished' | 'inQueue' | 'starting' | 'error';

export interface MaillistProgress {
  status: MaillistStatus;
  progress: number;
}

export interface MaillistResultRow {
  email: string;
  result: string;
}

/** A verificação unitária faz SMTP de verdade no destino; o teto evita segurar o cadastro. */
const SINGLE_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Download de lista grande: o corpo chega em streaming, o teto vale só para começar. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

interface ProviderErrorBody {
  message?: string;
  error?: string;
}

export class EmailListVerifyClient {
  private get baseUrl(): string {
    return (process.env.EMAIL_VERIFY_API_URL || 'https://api.emaillistverify.com').replace(/\/+$/, '');
  }

  private get apiKey(): string {
    return process.env.EMAIL_VERIFY_API_KEY || '';
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async verifyEmail(email: string): Promise<string> {
    const res = await this.request(`/api/verifyEmail?email=${encodeURIComponent(email)}`, {
      timeoutMs: SINGLE_TIMEOUT_MS,
    });
    const result = (await res.text()).trim().replace(/^"|"$/g, '');
    // A API responde 200 com este texto quando o saldo acaba.
    if (result === 'error_credit') {
      throw new EmailVerifyProviderError('Sem créditos na EmailListVerify.', 'credit');
    }
    return result;
  }

  /** O nome precisa ser único por conta: a API recusa um segundo envio com o mesmo nome. */
  async uploadList(csv: string, fileName: string): Promise<string> {
    const form = new FormData();
    form.append('file_contents', new Blob([csv], { type: 'text/csv' }), fileName);
    form.append('quality', 'standard');
    const res = await this.request('/api/verifyApiFile', { method: 'POST', body: form });
    const id = (await res.text()).trim().replace(/^"|"$/g, '');
    if (!id) throw new EmailVerifyProviderError('A EmailListVerify não devolveu o id da lista.', 'unavailable');
    return id;
  }

  async getProgress(listId: string): Promise<MaillistProgress> {
    const res = await this.request(`/api/maillists/${encodeURIComponent(listId)}/progress`);
    const body = (await res.json()) as Partial<MaillistProgress>;
    return { status: (body.status ?? 'processing') as MaillistStatus, progress: Number(body.progress ?? 0) };
  }

  /** Só o email usado e o resultado, sem as colunas originais: menos dados trafegando. */
  async *downloadResults(listId: string): AsyncGenerator<MaillistResultRow> {
    const query = new URLSearchParams({
      format: 'csv',
      addEmail: 'true',
      addResult: 'true',
      addOriginal: 'false',
      addNoEmailRows: 'false',
    });
    const res = await this.request(`/api/maillists/${encodeURIComponent(listId)}?${query}`, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    if (!res.body) return;
    yield* parseResultCsv(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>));
  }

  async deleteList(listId: string): Promise<void> {
    await this.request(`/api/maillists/${encodeURIComponent(listId)}`, { method: 'DELETE' });
  }

  private async request(
    path: string,
    opts: { method?: string; body?: FormData; timeoutMs?: number } = {}
  ): Promise<Response> {
    if (!this.configured) {
      throw new EmailVerifyProviderError('Verificação de emails não configurada (EMAIL_VERIFY_API_KEY).', 'auth');
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: opts.method ?? 'GET',
        headers: { 'x-api-key': this.apiKey },
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new EmailVerifyProviderError(`EmailListVerify indisponível: ${detail}`, 'unavailable');
    }

    if (res.ok) return res;
    throw await toProviderError(res);
  }
}

async function toProviderError(res: Response): Promise<EmailVerifyProviderError> {
  let body: ProviderErrorBody = {};
  try {
    body = (await res.json()) as ProviderErrorBody;
  } catch {
    // corpo vazio ou não-JSON: fica só o status
  }
  const message = body.message || `HTTP ${res.status}`;

  if (res.status === 401) return new EmailVerifyProviderError('Chave da EmailListVerify inválida.', 'auth');
  if (res.status === 403) {
    return /credit/i.test(message)
      ? new EmailVerifyProviderError('Sem créditos na EmailListVerify.', 'credit')
      : new EmailVerifyProviderError(`Conta da EmailListVerify bloqueada: ${message}`, 'auth');
  }
  // A API sinaliza excesso de requisições com 400 + error "TooManyRequests".
  if (res.status === 429 || body.error === 'TooManyRequests' || /too many/i.test(message)) {
    return new EmailVerifyProviderError('Limite de requisições da EmailListVerify atingido.', 'rate');
  }
  if (res.status >= 500) return new EmailVerifyProviderError(`EmailListVerify indisponível: ${message}`, 'unavailable');
  return new EmailVerifyProviderError(`EmailListVerify recusou a requisição: ${message}`, 'rejected');
}

/** Colunas pelo nome do cabeçalho ("ELV Email", "ELV Result"), não pela posição. */
export async function* parseResultCsv(input: NodeJS.ReadableStream): AsyncGenerator<MaillistResultRow> {
  const rl = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let delimiter = ',';
  let emailIdx = -1;
  let resultIdx = -1;

  try {
    for await (const raw of rl as AsyncIterable<string>) {
      const line = emailIdx < 0 ? raw.replace(/^﻿/, '') : raw;
      if (!line.trim()) continue;

      if (emailIdx < 0) {
        delimiter = detectDelimiter(line);
        const headers = splitLine(line, delimiter).map((h) => h.trim().toLowerCase());
        emailIdx = headers.indexOf('elv email');
        if (emailIdx < 0) emailIdx = headers.findIndex((h) => h.includes('email'));
        resultIdx = headers.indexOf('elv result');
        if (emailIdx < 0 || resultIdx < 0) {
          throw new EmailVerifyProviderError(
            'Arquivo de resultado da EmailListVerify sem as colunas esperadas.',
            'rejected'
          );
        }
        continue;
      }

      const cells = splitLine(line, delimiter);
      const email = (cells[emailIdx] ?? '').trim().toLowerCase();
      const result = (cells[resultIdx] ?? '').trim().toLowerCase();
      if (email && result && result !== '-') yield { email, result };
    }
  } finally {
    rl.close();
  }
}

export default new EmailListVerifyClient();
