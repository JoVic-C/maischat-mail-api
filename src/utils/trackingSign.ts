import crypto from 'node:crypto';

function secret(): string {
  return process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'mmail-dev-secret';
}

/** Só URLs assinadas na montagem do email podem ser redirecionadas pelo /tracking/click. */
export function signLink(campaignId: string, sendLogId: string, url: string): string {
  return crypto.createHmac('sha256', secret()).update(`${campaignId}:${sendLogId}:${url}`).digest('hex').slice(0, 16);
}

export function verifyLink(campaignId: string, sendLogId: string, url: string, sig: string): boolean {
  if (!sig) return false;
  const expected = signLink(campaignId, sendLogId, url);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

const UNSUBSCRIBE_PAYLOAD = 'unsubscribe';

/** Sem assinatura, quem conhecesse os ids (que vazam em emails encaminhados) descadastraria o destinatário. */
export function signUnsubscribe(campaignId: string, sendLogId: string): string {
  return signLink(campaignId, sendLogId, UNSUBSCRIBE_PAYLOAD);
}

export function verifyUnsubscribe(campaignId: string, sendLogId: string, sig: string): boolean {
  return verifyLink(campaignId, sendLogId, UNSUBSCRIBE_PAYLOAD, sig);
}
