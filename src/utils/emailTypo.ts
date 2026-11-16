/**
 * Detector de erro de digitação no domínio do email (`docs/prd-erro-digitacao.md`).
 * Regra pura, sem rede nem banco: quem chama fornece os domínios frequentes da base e os
 * aceitos pelo cliente.
 */

/** Domínios reais que nunca são suspeitos, mesmo parecidos com outro da lista. */
const KNOWN_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.com.br',
  'hotmail.co.uk',
  'hotmail.es',
  'hotmail.fr',
  'hotmail.it',
  'outlook.com',
  'outlook.com.br',
  'outlook.pt',
  'outlook.es',
  'live.com',
  'live.com.br',
  'live.co.uk',
  'live.com.pt',
  'msn.com',
  'yahoo.com',
  'yahoo.com.br',
  'yahoo.co.uk',
  'yahoo.es',
  'yahoo.fr',
  'ymail.com',
  'rocketmail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'uol.com.br',
  'bol.com.br',
  'terra.com.br',
  'ig.com.br',
  'globo.com',
  'globomail.com',
  'r7.com',
  'oi.com.br',
  'zipmail.com.br',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'email.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'tutanota.com',
  'hey.com',
]);

/** Erros frequentes que a distância de edição não pega ou pegaria com pouca confiança. */
const COMMON_TYPOS: Record<string, string> = {
  'gmail.com.br': 'gmail.com',
  'gmail.br': 'gmail.com',
  gmailcom: 'gmail.com',
  'icloud.com.br': 'icloud.com',
  'yahoo.br': 'yahoo.com.br',
  'hotmail.br': 'hotmail.com.br',
  hotmailcom: 'hotmail.com',
  'outlook.br': 'outlook.com.br',
  'uol.com': 'uol.com.br',
  'uol.br': 'uol.com.br',
  'uol.combr': 'uol.com.br',
  'bol.br': 'bol.com.br',
  'bol.combr': 'bol.com.br',
  'terra.com': 'terra.com.br',
  'terra.br': 'terra.com.br',
  'ig.br': 'ig.com.br',
  'ig.com': 'ig.com.br',
  'live.co': 'live.com',
  'liv.com': 'live.com',
  'lve.com': 'live.com',
};

/** Finais que não existem e quase sempre querem dizer `com`. */
const TLD_TYPOS = new Set([
  'con',
  'cmo',
  'ocm',
  'cpm',
  'cim',
  'vom',
  'xom',
  'comm',
  'coom',
  'conm',
  'comn',
  'copm',
  'ccom',
  'c0m',
  'cok',
  'col',
]);

/**
 * Alvos da comparação aproximada, em ordem de popularidade (desempata quando dois ficam à
 * mesma distância). Nomes curtos (uol, bol, ig, live) ficam de fora: a uma letra deles há
 * muito domínio real de empresa, e o mapa acima cobre os erros comuns.
 */
const PROVIDER_TARGETS: { domain: string; maxDistance: number }[] = [
  { domain: 'gmail.com', maxDistance: 2 },
  { domain: 'hotmail.com', maxDistance: 2 },
  { domain: 'outlook.com', maxDistance: 2 },
  { domain: 'icloud.com', maxDistance: 2 },
  { domain: 'yahoo.com.br', maxDistance: 2 },
  { domain: 'hotmail.com.br', maxDistance: 2 },
  { domain: 'outlook.com.br', maxDistance: 2 },
  { domain: 'yahoo.com', maxDistance: 1 },
];

/** Nome (sem o final) mínimo para comparar com os domínios da base: abaixo disso, colide demais. */
const BASE_MIN_NAME_LENGTH = 5;

/**
 * Um domínio raro só é suspeito pela base se o alvo tiver pelo menos esta vezes mais
 * contatos: `maischta.com.br` (12) contra `maischat.com.br` (500) é erro; duas empresas
 * reais parecidas, com volumes próximos, não.
 */
const BASE_DOMINANCE = 10;

export interface TypoContext {
  /**
   * Domínios frequentes na base do cliente, com a quantidade de contatos, já em minúsculas.
   * Servem de alvo para os domínios raros parecidos com eles.
   */
  references?: ReadonlyMap<string, number>;
  /** Domínios que o cliente revisou e decidiu manter, já em minúsculas. */
  accepted?: ReadonlySet<string>;
}
/**
 * Distância de Damerau-Levenshtein restrita (letra a mais, a menos, trocada ou invertida
 * com a vizinha). Para cedo quando passa de `max`.
 */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      row.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length];
}

export function normalizeTypoDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, '');
}

/** Troca um final inexistente (`.con`, `.cmo.br`) pelo `com` que a pessoa quis digitar. */
function fixTld(domain: string): string {
  const labels = domain.split('.');
  if (labels.length < 2) return domain;
  const last = labels.length - 1;
  if (TLD_TYPOS.has(labels[last])) labels[last] = 'com';
  else if (labels[last] === 'br' && labels.length >= 3 && TLD_TYPOS.has(labels[last - 1])) labels[last - 1] = 'com';
  return labels.join('.');
}

/** O alvo mais próximo dentro do limite; empate entre alvos diferentes não sugere nada. */
function closest(domain: string, targets: { domain: string; maxDistance: number }[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tie = false;

  for (const target of targets) {
    if (target.domain === domain) return null;
    const distance = editDistance(domain, target.domain, target.maxDistance);
    if (distance > target.maxDistance) continue;
    if (distance < bestDistance) {
      best = target.domain;
      bestDistance = distance;
      tie = false;
    } else if (distance === bestDistance) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/** Nome do domínio sem o final (`empresa` em `empresa.com.br`). */
function nameLength(domain: string): number {
  return domain.replace(/(\.(com|net|org|gov|edu|co))?\.[a-z]{2,}$/, '').length;
}

/** Domínios da base agrupados pelo tamanho: só vale comparar os de tamanho vizinho. */
const byLengthCache = new WeakMap<ReadonlyMap<string, number>, Map<number, string[]>>();

function referencesByLength(references: ReadonlyMap<string, number>): Map<number, string[]> {
  const cached = byLengthCache.get(references);
  if (cached) return cached;
  const index = new Map<number, string[]>();
  for (const ref of references.keys()) {
    if (nameLength(ref) < BASE_MIN_NAME_LENGTH) continue;
    const bucket = index.get(ref.length) ?? [];
    bucket.push(ref);
    index.set(ref.length, bucket);
  }
  byLengthCache.set(references, index);
  return index;
}

function closestInBase(domain: string, references: ReadonlyMap<string, number>): string | null {
  if (nameLength(domain) < BASE_MIN_NAME_LENGTH) return null;
  const own = references.get(domain) ?? 0;
  const index = referencesByLength(references);
  const targets: { domain: string; maxDistance: number }[] = [];
  for (const length of [domain.length - 1, domain.length, domain.length + 1]) {
    for (const ref of index.get(length) ?? []) {
      if (ref !== domain && (references.get(ref) ?? 0) >= Math.max(1, own * BASE_DOMINANCE)) {
        targets.push({ domain: ref, maxDistance: 1 });
      }
    }
  }
  return closest(domain, targets);
}

/**
 * Domínio que a pessoa provavelmente quis digitar, ou `null` se o domínio não é suspeito.
 * A ordem vai do sinal mais forte ao mais fraco: mapa de erros, final inexistente,
 * provedor popular, base do cliente. Ser frequente na base não livra um domínio parecido
 * com um provedor: `iclou.com` com 80 contatos continua sendo erro.
 */
export function suggestDomain(rawDomain: string, ctx: TypoContext = {}): string | null {
  const domain = normalizeTypoDomain(rawDomain);
  if (!domain) return null;
  if (KNOWN_DOMAINS.has(domain) || ctx.accepted?.has(domain)) return null;

  const mapped = COMMON_TYPOS[domain];
  if (mapped) return mapped;
  if (!domain.includes('.')) return null;

  const candidate = fixTld(domain);
  if (KNOWN_DOMAINS.has(candidate)) return candidate;

  const fromProvider = COMMON_TYPOS[candidate] ?? closest(candidate, PROVIDER_TARGETS);
  if (fromProvider) return fromProvider;

  const fromBase = ctx.references ? closestInBase(candidate, ctx.references) : null;
  if (fromBase) return fromBase;

  return candidate !== domain ? candidate : null;
}

/** Email com o domínio corrigido, ou `null` se o domínio não é suspeito. */
export function suggestEmail(email: string, ctx: TypoContext = {}): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  const suggestion = suggestDomain(email.slice(at + 1), ctx);
  return suggestion ? `${email.slice(0, at).trim().toLowerCase()}@${suggestion}` : null;
}
