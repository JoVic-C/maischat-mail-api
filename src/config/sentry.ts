/**
 * Sentry. Precisa ser o primeiro import do server.ts, porque o SDK instrumenta http,
 * express e mongo no carregamento. Sem SENTRY_DSN todas as funções viram no-op.
 */
import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger';

let enabled = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Em produção, sem DSN nenhum erro sai da máquina: o aviso tem que chamar atenção no boot.
    if (process.env.NODE_ENV === 'production') {
      logger.warn(
        '⚠️  SENTRY_DSN não definido em PRODUÇÃO — nenhum erro será reportado. ' +
          'Defina a variável no painel para ter rastreamento de falhas.'
      );
    } else {
      logger.info('ℹ️  Sentry desativado (SENTRY_DSN não definido)');
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // Nunca enviar corpo de requisição: por aqui passam CSVs de contatos e senhas SMTP.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
      }
      return event;
    },
  });

  enabled = true;
  logger.info(`🛰️  Sentry ativo (${process.env.NODE_ENV || 'development'})`);
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

/** Só id, email e papel. */
export function setSentryUser(user: { id: string; email: string; role: string } | null): void {
  if (!enabled) return;
  Sentry.setUser(user);
}

export { Sentry };
