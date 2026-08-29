import crypto from 'node:crypto';
import { logger } from './logger';

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:'; // marca o que já está criptografado

/** Deriva uma chave de 32 bytes a partir de um segredo. */
function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/** Chave ATUAL — usada para escrever. */
function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY not set in .env');
  return deriveKey(secret);
}

/**
 * Chaves aceitas na LEITURA: a atual e, opcionalmente, a anterior
 * (`ENCRYPTION_KEY_PREVIOUS`). É o que torna a rotação possível sem downtime:
 * publica-se a chave nova em ENCRYPTION_KEY, mantém-se a antiga em
 * ENCRYPTION_KEY_PREVIOUS e roda-se `npm run rotate:encryption` para reescrever
 * os dados. Depois disso a anterior pode ser removida do ambiente.
 */
function readKeys(): Buffer[] {
  const keys = [getKey()];
  const previous = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (previous) keys.push(deriveKey(previous));
  return keys;
}

/** Criptografa um texto → 'enc:v1:<iv>:<tag>:<dados>' (base64). Idempotente. */
export function encrypt(plain: string): string {
  if (!plain || typeof plain !== 'string') return plain;
  if (plain.startsWith(PREFIX)) return plain; // já criptografado
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

/** Descriptografa. Se não for 'enc:v1:', devolve como está (legado/plaintext). */
export function decrypt(value: string): string {
  if (!value || typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const [, , ivB64, tagB64, dataB64] = value.split(':');

  // Tenta a chave atual e depois a anterior (janela de rotação).
  for (const key of readKeys()) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // chave errada ou dado adulterado — tenta a próxima
    }
  }

  // Nenhuma chave abriu: NÃO devolve o ciphertext como se fosse valor.
  // Loga e retorna vazio para não propagar dado corrompido.
  logger.error('fieldCrypto.decrypt failed (GCM auth) — returning empty');
  return '';
}

/** true quando o valor está cifrado com a chave ATUAL (usado pela rotação). */
export function isCurrentKey(value: string): boolean {
  if (!value?.startsWith(PREFIX)) return false;
  const [, , ivB64, tagB64, dataB64] = value.split(':');
  try {
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}
