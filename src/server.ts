import 'dotenv/config';
import { initSentry, Sentry } from './config/sentry';

initSentry(); // antes de tudo: o SDK instrumenta http/express/mongo no carregamento

import cors from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import { version as APP_VERSION } from '../package.json';
import connectDB, { disconnectDB } from './config/db';
import { connectRedis, disconnectRedis } from './config/redis';
import { requireAdmin, requireAuth, requireSuperadmin } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { generalLimiter } from './middleware/rateLimit';
import { systemContext, tenantContext } from './middleware/tenant';
import { startEmailWorker, stopEmailWorker } from './queue/email.worker';
import { startImportWorker, stopImportWorker } from './queue/import.worker';
import { startSchedulerWorker, stopSchedulerWorker } from './queue/scheduler.worker';
import authRoutes from './routes/auth';
import bounceRoutes from './routes/bounce';
import campaignRoutes from './routes/campaigns';
import contactRoutes from './routes/contacts';
import dashboardRoutes from './routes/dashboard';
import listRoutes from './routes/lists';
import platformMonitorRoutes from './routes/platformMonitor';
import platformSettingsRoutes from './routes/platformSettings';
import segmentRoutes from './routes/segments';
import smtpRoutes from './routes/smtp';
import templateRoutes from './routes/templates';
import tenantRoutes from './routes/tenants';
import trackingRoutes from './routes/tracking';
import uploadRoutes from './routes/upload';
import userRoutes from './routes/users';
import webhookRoutes from './routes/webhook';
import { logger } from './utils/logger';

// Falha cedo se faltar config crítica de segurança (evita subir num estado inseguro).
for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY', 'MONGO_URI']) {
  if (!process.env[key]) {
    logger.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const app = express();
connectDB();

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

function frontendOrigin(): string | null {
  const fe = process.env.FRONTEND_URL;
  if (!fe) return null;
  try {
    return new URL(fe).origin;
  } catch {
    return null;
  }
}

// Domínios próprios sempre confiáveis: qualquer subdomínio maischat.io/.com.
// Só HTTPS: com `credentials: true`, aceitar http permitiria que um atacante na rede
// (ou um subdomínio servido em texto puro) lesse respostas autenticadas.
const TRUSTED_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*maischat\.(io|com)(:\d+)?$/i;

/** Origens de desenvolvimento local — o único fallback aceito fora de produção. */
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const allowedOrigins = [
  frontendOrigin(),
  ...(process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')),
].filter(Boolean) as string[];

app.use(
  cors({
    origin(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) {
      if (!origin) return cb(null, true); // curl / webhook / server-to-server
      const o = origin.replace(/\/+$/, ''); // tira barra final (o Origin nunca tem, mas o .env pode)
      if (allowedOrigins.includes(o)) return cb(null, true);
      if (TRUSTED_ORIGIN_RE.test(o)) return cb(null, true);
      // Fora de produção liberamos APENAS localhost — nunca refletimos uma origem arbitrária,
      // que com credentials:true daria a qualquer site acesso à sessão do dev.
      if (process.env.NODE_ENV !== 'production' && LOCALHOST_RE.test(o)) return cb(null, true);
      cb(null, false); // fora da lista → browser bloqueia (sem 500)
    },
    credentials: true,
  })
);
app.use(generalLimiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes); // público (login); /me já é protegido internamente

// ── Administração da plataforma (acima dos clientes) ──
app.use('/api/tenants', requireAuth, requireSuperadmin, tenantRoutes);
// Ajustes do motor de envio: valem para a plataforma inteira, então só o superadmin.
app.use('/api/platform-settings', requireAuth, requireSuperadmin, platformSettingsRoutes);
// Operação da plataforma: atravessa clientes (runAsSystem), por isso é só superadmin.
app.use('/api/platform-monitor', requireAuth, requireSuperadmin, platformMonitorRoutes);

// ── Painel: exigem login (JWT) + contexto de cliente ──
// O tenantContext abre o escopo: daqui para baixo TODA query sai filtrada pelo
// cliente do usuário (ver models/plugins/tenantScope).
app.use('/api/dashboard', requireAuth, tenantContext, dashboardRoutes);
app.use('/api/lists', requireAuth, tenantContext, listRoutes);
app.use('/api/contacts', requireAuth, tenantContext, contactRoutes);
app.use('/api/templates', requireAuth, tenantContext, templateRoutes);
app.use('/api/campaigns', requireAuth, tenantContext, campaignRoutes);
app.use('/api/smtp', requireAuth, requireAdmin, tenantContext, smtpRoutes);
app.use('/api/users', requireAuth, requireAdmin, tenantContext, userRoutes);
app.use('/api/segments', requireAuth, tenantContext, segmentRoutes);
app.use('/api/bounces', requireAuth, requireAdmin, tenantContext, bounceRoutes); // bloquear contato = só admin
app.use('/api/upload', requireAuth, uploadRoutes); // upload é arquivo em disco, sem query no banco

// ── Públicas (acessadas por terceiros/destinatários) ──
// Sem cliente na entrada: rodam em modo system (ver middleware/tenant).
app.use('/api/tracking', systemContext, trackingRoutes); // pixel/clique/descadastro, no navegador do destinatário
app.use('/api/webhooks', systemContext, webhookRoutes); // tem token próprio (Bearer do xMailer)
app.use('/uploads', express.static('uploads')); // imagens dos emails carregam sem login

app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: APP_VERSION, timestamp: new Date().toISOString() });
});

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.originalUrl}` });
});

// Captura no Sentry antes do nosso handler (que responde 500 sem vazar stack).
Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`🛑 ${signal} received — shutting down gracefully...`);

  const forceTimer = setTimeout(() => {
    logger.error('⚠️  Forced shutdown (timeout)');
    process.exit(1);
  }, 15000);
  forceTimer.unref();

  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopEmailWorker();
    await stopImportWorker();
    await stopSchedulerWorker();
    await disconnectRedis();
    await disconnectDB();
    clearTimeout(forceTimer);
    logger.info('👋 Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { message: (err as Error).message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, async () => {
  await connectRedis();
  logger.info(`🟢 mMail API listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  // Assíncrono: o worker lê concorrência e taxa dos ajustes da plataforma antes de subir.
  await startEmailWorker();
  // Validação e gravação de CSV grande: fila própria, para não disputar com o envio.
  await startImportWorker();
  startSchedulerWorker();
});
