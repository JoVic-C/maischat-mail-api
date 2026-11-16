import { promises as dns } from 'node:dns';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sem teto, um servidor DNS que não responde segura o lote inteiro da importação. */
const DNS_TIMEOUT_MS = 3000;

const resolver = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });

/** Respostas que provam que o nome não existe; o resto é falha do caminho até o DNS. */
const DEFINITIVE_CODES = new Set(['ENOTFOUND', 'ENODATA']);

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? '';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** RFC 7505: um único MX "." declara que o domínio não recebe email. */
function isNullMx(records: { exchange: string }[]): boolean {
  return records.length === 1 && (records[0].exchange === '' || records[0].exchange === '.');
}

/**
 * Primeira etapa, grátis, da checagem de domínio (`domainCheck.service`): o domínio
 * tem MX ou, na falta dele, registro A. Na dúvida (DNS fora), aprova.
 */
export async function dnsAcceptsMail(domain: string): Promise<boolean> {
  let mxSaysMissing = false;

  try {
    const mx = await resolver.resolveMx(domain);
    if (mx.length > 0) return !isNullMx(mx);
  } catch (err) {
    mxSaysMissing = errorCode(err) === 'ENOTFOUND';
  }

  // `dns.lookup` usa getaddrinfo, que funciona onde consultas DNS diretas são bloqueadas.
  try {
    await withTimeout(dns.lookup(domain), DNS_TIMEOUT_MS);
    return true;
  } catch (err) {
    if (DEFINITIVE_CODES.has(errorCode(err))) return false;
    // Falha do nosso DNS não prova que o domínio não existe: na dúvida, o contato não é recusado.
    return !mxSaysMissing;
  }
}

export function domainOf(email: string): string {
  return (email.split('@')[1] ?? '').trim().toLowerCase().replace(/\.$/, '');
}
