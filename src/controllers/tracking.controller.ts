import type { Request, Response } from 'express';
import Campaign from '../models/Campaign';
import Contact from '../models/Contact';
import SendLog from '../models/SendLog';
import { logSideEffect } from '../utils/logger';
import { verifyLink, verifyUnsubscribe } from '../utils/trackingSign';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Teto de URLs distintas guardadas em linkStats — blinda o doc contra crescer sem fim (limite 16MB). */
const MAX_LINK_STATS = 100;

/** Valida o destino de um clique: só http/https absoluto (bloqueia open-redirect, //host e javascript:). */
function safeRedirectTarget(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    /* url inválida → sem destino */
  }
  return '';
}

export const trackOpen = async (req: Request, res: Response): Promise<void> => {
  try {
    const { c: campaignId, id: sendLogId } = req.params;
    // Atômico: só o 1º open reivindica (openCount 0→1) e conta na campanha — evita superconta sob concorrência.
    const first = await SendLog.findOneAndUpdate(
      { _id: sendLogId, campaignId, openCount: 0 },
      { $inc: { openCount: 1 }, $set: { openedAt: new Date() } }
    );
    if (first) {
      await SendLog.updateOne({ _id: sendLogId, status: 'sent' }, { $set: { status: 'opened' } });
      await Campaign.updateOne({ _id: campaignId }, { $inc: { 'stats.opened': 1 } });
    } else {
      // opens seguintes (ou id inexistente): só incrementa o contador do log
      await SendLog.updateOne({ _id: sendLogId, campaignId }, { $inc: { openCount: 1 } });
    }
  } catch (err) {
    logSideEffect('tracking.open', err);
  }

  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.send(PIXEL);
};

export const trackClick = async (req: Request, res: Response): Promise<void> => {
  const { c: campaignId, id: sendLogId } = req.params;
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  // Destino válido SÓ se for http/https E a assinatura conferir — só redirecionamos para
  // links que nós mesmos assinamos ao montar o email (fecha o open-redirect por completo).
  const candidate = safeRedirectTarget(rawUrl);
  const safeUrl = candidate && verifyLink(campaignId, sendLogId, rawUrl, sig) ? candidate : '';

  try {
    // Atômico: só o 1º clique reivindica e conta na campanha.
    const first = await SendLog.findOneAndUpdate(
      { _id: sendLogId, campaignId, clickCount: 0 },
      { $inc: { clickCount: 1 }, $set: { clickedAt: new Date() } }
    );
    if (first) {
      await SendLog.updateOne({ _id: sendLogId, status: { $ne: 'unsubscribed' } }, { $set: { status: 'clicked' } });
      await Campaign.updateOne({ _id: campaignId }, { $inc: { 'stats.clicked': 1 } });
    } else {
      await SendLog.updateOne({ _id: sendLogId, campaignId }, { $inc: { clickCount: 1 } });
    }

    // Cliques por link — só destinos válidos, e com teto de tamanho no array.
    if (safeUrl) {
      const inc = await Campaign.updateOne(
        { _id: campaignId, 'linkStats.url': safeUrl },
        { $inc: { 'linkStats.$.clicks': 1 } }
      );
      if (inc.modifiedCount === 0) {
        await Campaign.updateOne(
          {
            _id: campaignId,
            'linkStats.url': { $ne: safeUrl },
            [`linkStats.${MAX_LINK_STATS - 1}`]: { $exists: false }, // só adiciona se ainda houver espaço
          },
          { $push: { linkStats: { url: safeUrl, clicks: 1 } } }
        );
      }
    }
  } catch (err) {
    logSideEffect('tracking.click', err);
  }

  res.redirect(safeUrl || '/');
};

/** Página simples de erro para link de descadastro inválido/adulterado. */
function invalidUnsubscribePage(res: Response): void {
  res
    .status(400)
    .set('Content-Type', 'text/html; charset=utf-8')
    .send(
      `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
    <meta name="robots" content="noindex"><title>Link inválido</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;color:#333">
      <h1>Link inválido</h1>
      <p>Este link de cancelamento não é válido ou expirou. Use o link do email mais recente.</p>
    </body></html>`
    );
}

/** GET: página de confirmação — NÃO descadastra (impede que scanner/prefetch cancele por um GET). */
export const unsubscribeConfirmPage = (req: Request, res: Response): void => {
  const { c: campaignId, id: sendLogId } = req.params;
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  // Sem assinatura válida qualquer um que conheça os dois ObjectIds (que vazam em emails
  // encaminhados) descadastraria o destinatário.
  if (!verifyUnsubscribe(campaignId, sendLogId, sig)) {
    invalidUnsubscribePage(res);
    return;
  }
  // encodeURIComponent blinda contra XSS refletido: os ids vêm da URL (não validados) e
  // são embutidos no HTML — encodar impede quebrar o atributo com aspas/tags.
  const action = `/api/tracking/unsubscribe/${encodeURIComponent(campaignId)}/${encodeURIComponent(sendLogId)}?sig=${encodeURIComponent(sig)}`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
    <meta name="robots" content="noindex"><title>Cancelar inscrição</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;color:#333">
      <h1>Cancelar inscrição</h1>
      <p>Confirme para não receber mais nossos emails.</p>
      <form method="POST" action="${action}">
        <button type="submit" style="padding:12px 28px;font-size:15px;background:#7C3AED;color:#fff;border:none;border-radius:8px;cursor:pointer">
          Confirmar cancelamento
        </button>
      </form>
    </body></html>`);
};

/** POST: efetua o descadastro (idempotente). Chamado pelo botão da página ou pelo one-click (RFC 8058). */
export const trackUnsubscribe = async (req: Request, res: Response): Promise<void> => {
  const { c: campaignId, id: sendLogId } = req.params;
  // O one-click (RFC 8058) preserva a query string do List-Unsubscribe; o form da página
  // de confirmação repassa a mesma assinatura.
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  if (!verifyUnsubscribe(campaignId, sendLogId, sig)) {
    invalidUnsubscribePage(res);
    return;
  }

  try {
    // Idempotente: só conta no 1º descadastro (evita inflar por reload).
    const log = await SendLog.findOneAndUpdate(
      { _id: sendLogId, campaignId, status: { $ne: 'unsubscribed' } },
      { $set: { status: 'unsubscribed' } }
    );
    if (log) {
      await Contact.updateOne({ _id: log.contactId }, { status: 'unsubscribed', unsubscribedAt: new Date() });
      await Campaign.updateOne({ _id: campaignId }, { $inc: { 'stats.unsubscribed': 1 } });
    }
  } catch (err) {
    logSideEffect('tracking.unsubscribe', err);
  }

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
    <title>Inscrição cancelada</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;color:#333">
      <h1>Inscrição cancelada</h1>
      <p>Você não receberá mais nossos emails. 👋</p>
    </body></html>`);
};
