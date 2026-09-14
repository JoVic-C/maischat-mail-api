import type { Request } from 'express';

const APP_NAME = process.env.APP_NAME || 'mmail-api';

type Meta = Record<string, unknown>;

/**
 * Escreve nos streams em vez de usar `console.*`: a correção automática da regra
 * `noConsole` do Biome remove chamadas de console, e já apagou o log da aplicação uma vez.
 * Erro vai para stderr.
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

export function logCtrlError(scope: string, req: Request, err: unknown): void {
  logger.error(`${scope} failed`, {
    method: req.method,
    path: req.originalUrl,
    message: err instanceof Error ? err.message : String(err),
  });
}

export function logError(scope: string, err: unknown, ctx?: Meta): void {
  logger.error(`${scope} failed`, { ...ctx, message: err instanceof Error ? err.message : String(err) });
}

/** Falha que não deve interromper o fluxo principal (ex.: envio de email). */
export function logSideEffect(scope: string, err: unknown, ctx?: Meta): void {
  logger.warn(`${scope} (side-effect) failed`, { ...ctx, message: err instanceof Error ? err.message : String(err) });
}

export function logWarn(scope: string, message: string, ctx?: Meta): void {
  logger.warn(`${scope}: ${message}`, ctx);
}
