/**
 * Sentry — rastreamento de erros com stack trace e contexto.
 *
 * Precisa ser importado ANTES de qualquer outro módulo da aplicação (o SDK instrumenta
 * http/express/mongo no require), por isso é o primeiro import do server.ts.
 * Sem SENTRY_DSN no ambiente o SDK não é inicializado e todas as funções viram no-op —
 * dev e testes rodam sem depender de rede.
 */
import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger';

let enabled = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('ℹ️  Sentry desativado (SENTRY_DSN não definido)');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    // Amostragem de performance: 10% por padrão para não estourar a cota.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // Nunca enviar corpo de requisição: aqui trafegam CSV de contatos e senhas SMTP.
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

/** Envia um erro ao Sentry com contexto. No-op quando o SDK não está ativo. */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

/** Identifica o usuário autenticado no evento (só id/email/papel — nada sensível). */
export function setSentryUser(user: { id: string; email: string; role: string } | null): void {
  if (!enabled) return;
  Sentry.setUser(user);
}

export { Sentry };
