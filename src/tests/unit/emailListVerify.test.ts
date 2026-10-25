import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailListVerifyClient, EmailVerifyProviderError, parseResultCsv } from '../../services/emailListVerify.client';
import { classifyElvResult, verificationReason } from '../../utils/emailVerification';

const fetchMock = vi.fn();

function resposta(status: number, body: string, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

async function erroDe(promessa: Promise<unknown>): Promise<EmailVerifyProviderError> {
  try {
    await promessa;
  } catch (err) {
    if (err instanceof EmailVerifyProviderError) return err;
    throw err;
  }
  throw new Error('a chamada deveria ter falhado');
}

describe('classificação dos resultados da EmailListVerify', () => {
  it.each([
    ['ok', 'deliverable'],
    ['email_disabled', 'undeliverable'],
    ['dead_server', 'undeliverable'],
    ['invalid_mx', 'undeliverable'],
    ['invalid_syntax', 'undeliverable'],
    ['spamtrap', 'undeliverable'],
    ['ok_for_all', 'risky'],
    ['disposable', 'risky'],
    ['unknown', 'unknown'],
    ['smtp_protocol', 'unknown'],
    ['antispam_system', 'unknown'],
    ['algo_novo_da_api', 'unknown'],
  ])('%s → %s', (resultado, status) => {
    expect(classifyElvResult(resultado)).toBe(status);
  });

  it('explica o motivo em português', () => {
    expect(verificationReason('email_disabled')).toMatch(/não existe/);
    expect(verificationReason('desconhecido')).toBe('Não foi possível verificar');
  });
});

describe('cliente da EmailListVerify', () => {
  const client = new EmailListVerifyClient();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('EMAIL_VERIFY_API_KEY', 'chave-teste');
    vi.stubEnv('EMAIL_VERIFY_API_URL', 'https://elv.test');
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sem chave fica desligado e não chama a API', async () => {
    vi.stubEnv('EMAIL_VERIFY_API_KEY', '');
    expect(client.configured).toBe(false);
    expect((await erroDe(client.verifyEmail('ana@x.com'))).kind).toBe('auth');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifica um email com a chave no cabeçalho, não na URL', async () => {
    fetchMock.mockResolvedValue(resposta(200, 'email_disabled', 'text/html'));
    expect(await client.verifyEmail('ana+teste@empresa.com.br')).toBe('email_disabled');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://elv.test/api/verifyEmail?email=ana%2Bteste%40empresa.com.br');
    expect(url).not.toContain('chave-teste');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('chave-teste');
  });

  it('error_credit vira erro de crédito', async () => {
    fetchMock.mockResolvedValue(resposta(200, 'error_credit', 'text/html'));
    expect((await erroDe(client.verifyEmail('ana@x.com'))).kind).toBe('credit');
  });

  it.each([
    [401, { message: 'Invalid api key', error: 'Unauthorized' }, 'auth', false],
    [403, { message: 'Not enough credit, 10 required.', error: 'Forbidden' }, 'credit', false],
    [403, { message: 'This account has been disabled.', error: 'Forbidden' }, 'auth', false],
    [400, { message: 'Too many requests coming from your API key.', error: 'TooManyRequests' }, 'rate', true],
    [503, { message: 'Service Unavailable' }, 'unavailable', true],
    [400, { message: 'You have already uploaded a maillist file with this name' }, 'rejected', false],
  ])('HTTP %i → %s', async (status, body, kind, transient) => {
    fetchMock.mockResolvedValue(resposta(status, JSON.stringify(body)));
    const err = await erroDe(client.getProgress('123'));
    expect(err.kind).toBe(kind);
    expect(err.transient).toBe(transient);
  });

  it('falha de rede ou tempo esgotado é passageira', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const err = await erroDe(client.verifyEmail('ana@x.com'));
    expect(err.kind).toBe('unavailable');
    expect(err.transient).toBe(true);
  });

  it('envia a lista como arquivo multipart e devolve o id', async () => {
    fetchMock.mockResolvedValue(resposta(201, '2616806', 'text/html'));
    expect(await client.uploadList('email\nana@x.com\n', 'mailpulse-1.csv')).toBe('2616806');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://elv.test/api/verifyApiFile');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form.get('quality')).toBe('standard');
    const arquivo = form.get('file_contents') as File;
    expect(arquivo.name).toBe('mailpulse-1.csv');
    expect(await arquivo.text()).toBe('email\nana@x.com\n');
  });

  it('lê o progresso da lista', async () => {
    fetchMock.mockResolvedValue(resposta(200, JSON.stringify({ status: 'processing', progress: 42 })));
    expect(await client.getProgress('123')).toEqual({ status: 'processing', progress: 42 });
  });

  it('baixa só o email e o resultado', async () => {
    fetchMock.mockResolvedValue(resposta(200, 'ELV Result,ELV Email\nok,ana@x.com\n', 'text/csv'));
    const linhas = [];
    for await (const linha of client.downloadResults('123')) linhas.push(linha);

    expect(linhas).toEqual([{ email: 'ana@x.com', result: 'ok' }]);
    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe('/api/maillists/123');
    expect(url.searchParams.get('addEmail')).toBe('true');
    expect(url.searchParams.get('addOriginal')).toBe('false');
  });
});

describe('leitura do arquivo de resultado', () => {
  async function ler(csv: string) {
    const linhas = [];
    for await (const linha of parseResultCsv(Readable.from([csv]))) linhas.push(linha);
    return linhas;
  }

  it('acha as colunas pelo nome, em qualquer ordem e com BOM', async () => {
    const csv = '﻿ELV Email;ELV Result\nANA@X.com;OK\nbruno@x.com;email_disabled\r\n';
    expect(await ler(csv)).toEqual([
      { email: 'ana@x.com', result: 'ok' },
      { email: 'bruno@x.com', result: 'email_disabled' },
    ]);
  });

  it('ignora linhas sem resultado (-) e linhas vazias', async () => {
    expect(await ler('ELV Result,ELV Email\n-,sem@x.com\n\nok,ana@x.com\n')).toEqual([
      { email: 'ana@x.com', result: 'ok' },
    ]);
  });

  it('cabeçalho sem as colunas esperadas é erro, não importação silenciosa de nada', async () => {
    await expect(ler('a,b\n1,2\n')).rejects.toThrow(/colunas esperadas/);
  });
});
