import type { Request } from 'express';

const APP_NAME = process.env.APP_NAME || 'mmail-api';

type Meta = Record<string, unknown>;

/**
 * Escreve direto nos streams em vez de `console.*`.
 *
 * O motivo é concreto: a regra `noConsole` do Biome tem correção automática que
 * REMOVE a chamada de console — e uma passagem de `--write --unsafe` já apagou o
 * console.log daqui uma vez, deixando a aplicação inteira sem log em silêncio.
 * `process.stdout` não é alcançado por essa regra.
 *
 * Erro vai para stderr (convenção do Unix): agregadores de log separam os dois,
 * e um container que só escreve em stdout esconde falha no meio do fluxo normal.
 */
function line(level: string, message: string, meta?: Meta): void {
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const texto = `[${APP_NAME}] ${ts} [${level}]: ${message}${metaStr}\n`;

  if (level === 'error') process.stderr.write(texto);
  else process.stdout.write(texto);
}

export const logger = {
  info: (message: string, meta?: Meta) => line('info', message, meta),
  warn: (message: string, meta?: Meta) => line('warn', message, meta),
  error: (message: string, meta?: Meta) => line('error', message, meta),
};

/** Erro dentro de um controller — inclui contexto da requisição. */
export function logCtrlError(scope: string, req: Request, err: unknown): void {
  logger.error(`${scope} failed`, {
    method: req.method,
    path: req.originalUrl,
    message: err instanceof Error ? err.message : String(err),
  });
}

/** Erro genérico com contexto opcional. */
export function logError(scope: string, err: unknown, ctx?: Meta): void {
  logger.error(`${scope} failed`, { ...ctx, message: err instanceof Error ? err.message : String(err) });
}

/** Efeito colateral que falhou mas não deve derrubar o fluxo (ex.: envio de email). */
export function logSideEffect(scope: string, err: unknown, ctx?: Meta): void {
  logger.warn(`${scope} (side-effect) failed`, { ...ctx, message: err instanceof Error ? err.message : String(err) });
}

export function logWarn(scope: string, message: string, ctx?: Meta): void {
  logger.warn(`${scope}: ${message}`, ctx);
}
