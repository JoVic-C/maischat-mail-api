import crypto from 'node:crypto';

/** Segredo para assinar os links de tracking (reaproveita config já obrigatória no boot). */
function secret(): string {
  return process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'mmail-dev-secret';
}

/**
 * Assina um link de clique. Só URLs que passaram por aqui (montadas a partir do template real)
 * poderão ser redirecionadas — fecha o open-redirect no /tracking/click.
 */
export function signLink(campaignId: string, sendLogId: string, url: string): string {
  return crypto.createHmac('sha256', secret()).update(`${campaignId}:${sendLogId}:${url}`).digest('hex').slice(0, 16);
}

/** Confere a assinatura de um link de clique (comparação timing-safe). */
export function verifyLink(campaignId: string, sendLogId: string, url: string, sig: string): boolean {
  if (!sig) return false;
  const expected = signLink(campaignId, sendLogId, url);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** Payload fixo do link de descadastro (não há URL de destino para assinar). */
const UNSUBSCRIBE_PAYLOAD = 'unsubscribe';

/**
 * Assina o link de descadastro. Sem isso, quem conhecer os dois ObjectIds
 * (que vazam em emails encaminhados) descadastra o destinatário.
 */
export function signUnsubscribe(campaignId: string, sendLogId: string): string {
  return signLink(campaignId, sendLogId, UNSUBSCRIBE_PAYLOAD);
}

export function verifyUnsubscribe(campaignId: string, sendLogId: string, sig: string): boolean {
  return verifyLink(campaignId, sendLogId, UNSUBSCRIBE_PAYLOAD, sig);
}
