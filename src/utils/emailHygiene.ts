import { promises as dns } from 'node:dns';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function domainHasMail(domain: string, cache: Map<string, boolean>): Promise<boolean> {
  const key = domain.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;

  let ok = false;

  // 1) Consulta MX (ideal: confirma que o domínio RECEBE email).
  try {
    const mx = await dns.resolveMx(key);
    if (Array.isArray(mx) && mx.length > 0) ok = true;
  } catch {
    // segue para o fallback
  }

  // 2) Fallback: o domínio ao menos existe/resolve? Usa getaddrinfo (dns.lookup),
  //    que funciona mesmo onde consultas DNS diretas (resolveMx/resolve) são bloqueadas.
  if (!ok) {
    try {
      await dns.lookup(key);
      ok = true;
    } catch {
      ok = false;
    }
  }

  cache.set(key, ok);
  return ok;
}
