import type { NextFunction, Request, Response } from 'express';
import { runAsSystem, runWithTenant } from '../config/tenantContext';
import formWebhookService from '../services/formWebhook.service';
import { logCtrlError } from '../utils/logger';

const NOT_FOUND = { error: 'Webhook não encontrado.' };

/** Formulário HTML sem JavaScript: o navegador espera uma página, não JSON. */
function isBrowserFormPost(req: Request): boolean {
  return (
    Boolean(req.is(['application/x-www-form-urlencoded', 'multipart/form-data'])) &&
    req.accepts(['json', 'html']) === 'html'
  );
}

function withStatus(url: string, ok: boolean): string {
  try {
    const target = new URL(url);
    target.searchParams.set('mmail', ok ? 'enviado' : 'erro');
    return target.toString();
  } catch {
    return url;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function backLink(req: Request): string | null {
  const referer = req.get('referer');
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Página mostrada a quem preencheu o formulário: sem detalhes internos do mMail. */
function resultPage(req: Request, ok: boolean, title: string, message: string): string {
  const back = backLink(req);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: #f3f5fa;
    color: #1b2440; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 420px; text-align: center; background: #fff; border: 1px solid #e1e5ef; border-radius: 16px; padding: 32px 28px; }
  .icon { width: 48px; height: 48px; margin: 0 auto 14px; border-radius: 50%; display: grid; place-items: center;
    font-size: 24px; font-weight: 700; }
  .ok { background: #e3f6ee; color: #0f8a5f; }
  .err { background: #fdeaea; color: #c62f2f; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0; color: #5b6380; }
  a { display: inline-block; margin-top: 20px; color: #1b2440; font-weight: 600; }
</style>
</head>
<body>
<main>
  <div class="icon ${ok ? 'ok' : 'err'}" aria-hidden="true">${ok ? '✓' : '!'}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  ${back ? `<a href="${escapeHtml(back)}">Voltar ao site</a>` : ''}
</main>
</body>
</html>`;
}

function sendPage(req: Request, res: Response, status: number, ok: boolean, title: string, message: string): void {
  res
    .status(status)
    .type('html')
    .send(resultPage(req, ok, title, message));
}

export const listFormWebhooks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await formWebhookService.list());
  } catch (err) {
    logCtrlError('formWebhook.list', req, err);
    next(err);
  }
};

export const saveFormWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const webhook = await formWebhookService.save(req.body);
    res.json({ message: 'Webhook salvo.', webhook });
  } catch (err) {
    logCtrlError('formWebhook.save', req, err);
    next(err);
  }
};

export const regenerateFormWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const webhook = await formWebhookService.regenerate(req.params.id);
    res.json({ message: 'Nova URL gerada. A anterior deixou de funcionar.', webhook });
  } catch (err) {
    logCtrlError('formWebhook.regenerate', req, err);
    next(err);
  }
};

export const deleteFormWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await formWebhookService.remove(req.params.id);
    res.status(204).send();
  } catch (err) {
    logCtrlError('formWebhook.delete', req, err);
    next(err);
  }
};

export const getFormSubmissions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await formWebhookService.submissions(req.params.id));
  } catch (err) {
    logCtrlError('formWebhook.submissions', req, err);
    next(err);
  }
};

export const probeFormWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const webhook = await runAsSystem(() => formWebhookService.findByToken(req.params.token));
    if (!webhook) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.json({ ok: true, message: 'Webhook ativo. Envie os dados do formulário com POST.' });
  } catch (err) {
    logCtrlError('formWebhook.probe', req, err);
    next(err);
  }
};

export const receiveFormSubmission = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const browser = isBrowserFormPost(req);
    const webhook = await runAsSystem(() => formWebhookService.findByToken(req.params.token));
    if (!webhook) {
      if (browser) {
        sendPage(
          req,
          res,
          404,
          false,
          'Formulário indisponível',
          'Este formulário não está recebendo envios no momento.'
        );
      } else {
        res.status(404).json(NOT_FOUND);
      }
      return;
    }

    const outcome = await runWithTenant(webhook.tenantId, () =>
      formWebhookService.receive(webhook.id, req.body, req.ip ?? '')
    );

    if (browser) {
      if (webhook.redirectUrl) {
        res.redirect(303, withStatus(webhook.redirectUrl, outcome.kind !== 'rejected'));
      } else if (outcome.kind === 'rejected') {
        const message =
          outcome.status === 429
            ? 'Recebemos muitos envios agora. Tente novamente em alguns minutos.'
            : 'Confira o email informado e tente novamente.';
        sendPage(req, res, outcome.status, false, 'Não foi possível enviar', message);
      } else {
        sendPage(
          req,
          res,
          200,
          true,
          'Recebemos seus dados',
          'Obrigado! Em instantes você recebe a confirmação no seu email.'
        );
      }
      return;
    }

    if (outcome.kind === 'rejected') {
      res.status(outcome.status).json({ error: outcome.message });
      return;
    }
    res.status(202).json({ ok: true, message: 'Recebido.' });
  } catch (err) {
    logCtrlError('formWebhook.receive', req, err);
    next(err);
  }
};
