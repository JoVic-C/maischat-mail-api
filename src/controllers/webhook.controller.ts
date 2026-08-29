import type { NextFunction, Request, Response } from 'express';
import bounceService from '../services/bounce.service';
import { logCtrlError, logger } from '../utils/logger';

/** Recebe o webhook do xMailer: status 0=hard bounce, 1=entregue, 2=soft bounce. */
export const xmailerWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expected = process.env.XMAILER_WEBHOOK_TOKEN;
  // Fail-closed: sem token configurado, a rota fica fechada (nunca aberta a qualquer um).
  if (!expected) {
    res.status(503).json({ error: 'Webhook not configured.' });
    return;
  }
  if (token !== expected) {
    res.status(401).json({ error: 'Invalid token.' });
    return;
  }

  try {
    const { status, email_para, mensagem, msgid } = req.body as {
      status?: number;
      email_para?: string;
      mensagem?: string;
      msgid?: string;
    };
    const email = String(email_para || '')
      .toLowerCase()
      .trim();

    if (email) {
      if (status === 0) {
        logger.warn(`📮 xMailer HARD bounce → ${email}: ${mensagem || ''} (msgid ${msgid || '-'})`);
        await bounceService.processBounce(email, undefined, mensagem || 'Hard bounce (xMailer)'); // marca contato inválido
      } else if (status === 2) {
        logger.warn(`📮 xMailer SOFT bounce → ${email}: ${mensagem || ''}`);
        await bounceService.processSoftBounce(email, mensagem); // só registra
      }
      // status === 1 (entregue) → apenas confirmamos abaixo
    }

    res.json({ ok: true }); // o xMailer exige 2xx, senão re-tenta
  } catch (err) {
    logCtrlError('webhook.xmailer', req, err);
    next(err);
  }
};
