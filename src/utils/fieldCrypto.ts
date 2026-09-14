import crypto from 'node:crypto';
import { logger } from './logger';

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY not set in .env');
  return deriveKey(secret);
}

/**
 * Na leitura vale também `ENCRYPTION_KEY_PREVIOUS`, o que permite rotacionar a chave sem
 * downtime (ver scripts/rotateEncryption).
 */
function readKeys(): Buffer[] {
  const keys = [getKey()];
  const previous = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (previous) keys.push(deriveKey(previous));
  return keys;
}

/** 'enc:v1:<iv>:<tag>:<dados>' em base64. Idempotente. */
export function encrypt(plain: string): string {
  if (!plain || typeof plain !== 'string') return plain;
  if (plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

/** Valor sem o prefixo é devolvido como está (dado legado em texto puro). */
export function decrypt(value: string): string {
  if (!value || typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const [, , ivB64, tagB64, dataB64] = value.split(':');

  for (const key of readKeys()) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // chave errada ou dado adulterado: tenta a próxima
    }
  }

  // Nunca devolve o texto cifrado como se fosse o valor.
  logger.error('fieldCrypto.decrypt failed (GCM auth) — returning empty');
  return '';
}

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
