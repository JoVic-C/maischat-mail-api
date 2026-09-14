/**
 * Aplicação Express. Separada do `server.ts` para que importá-la não abra porta, não
 * conecte no banco nem suba worker — é o que os testes de integração usam.
 */
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import { version as APP_VERSION } from '../package.json';
import { Sentry } from './config/sentry';
import { requireAdmin, requireAuth, requireSuperadmin } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { generalLimiter } from './middleware/rateLimit';
import { systemContext, tenantContext } from './middleware/tenant';
import authRoutes from './routes/auth';
import bounceRoutes from './routes/bounce';
import campaignRoutes from './routes/campaigns';
import contactRoutes from './routes/contacts';
import dashboardRoutes from './routes/dashboard';
import listRoutes from './routes/lists';
import platformMonitorRoutes from './routes/platformMonitor';
import platformSettingsRoutes from './routes/platformSettings';
import segmentRoutes from './routes/segments';
import sendingDomainRoutes from './routes/sendingDomains';
import smtpRoutes from './routes/smtp';
import templateRoutes from './routes/templates';
import tenantRoutes from './routes/tenants';
import trackingRoutes from './routes/tracking';
import uploadRoutes from './routes/upload';
import userRoutes from './routes/users';
import webhookRoutes from './routes/webhook';
import { logWarn } from './utils/logger';

const app = express();

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

// Só HTTPS: com `credentials: true`, aceitar http exporia respostas autenticadas na rede.
const TRUSTED_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*maischat\.(io|com)(:\d+)?$/i;

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const allowedOrigins = [
  frontendOrigin(),
  ...(process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')),
].filter(Boolean) as string[];

app.use(
  cors({
    origin(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) {
      if (!origin) return cb(null, true); // server-to-server
      const o = origin.replace(/\/+$/, '');
      if (allowedOrigins.includes(o)) return cb(null, true);
      if (TRUSTED_ORIGIN_RE.test(o)) return cb(null, true);
      // Nunca refletir origem arbitrária: com credentials, qualquer site leria a sessão.
      if (process.env.NODE_ENV !== 'production' && LOCALHOST_RE.test(o)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  })
);
app.use(generalLimiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);

// Administração da plataforma: atravessa clientes, só superadmin.
app.use('/api/tenants', requireAuth, requireSuperadmin, tenantRoutes);
app.use('/api/platform-settings', requireAuth, requireSuperadmin, platformSettingsRoutes);
app.use('/api/platform-monitor', requireAuth, requireSuperadmin, platformMonitorRoutes);

// Painel: a partir do tenantContext toda query sai filtrada pelo cliente.
app.use('/api/dashboard', requireAuth, tenantContext, dashboardRoutes);
app.use('/api/lists', requireAuth, tenantContext, listRoutes);
app.use('/api/contacts', requireAuth, tenantContext, contactRoutes);
app.use('/api/templates', requireAuth, tenantContext, templateRoutes);
app.use('/api/campaigns', requireAuth, tenantContext, campaignRoutes);
app.use('/api/smtp', requireAuth, requireAdmin, tenantContext, smtpRoutes);
app.use('/api/sending-domains', requireAuth, requireAdmin, tenantContext, sendingDomainRoutes);
app.use('/api/users', requireAuth, requireAdmin, tenantContext, userRoutes);
app.use('/api/segments', requireAuth, tenantContext, segmentRoutes);
app.use('/api/bounces', requireAuth, requireAdmin, tenantContext, bounceRoutes);
app.use('/api/upload', requireAuth, uploadRoutes);

// Públicas: sem cliente na entrada, rodam em modo system.
app.use('/api/tracking', systemContext, trackingRoutes);
app.use('/api/webhooks', systemContext, webhookRoutes);
app.use('/uploads', express.static('uploads'));

app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: APP_VERSION, timestamp: new Date().toISOString() });
});

// O caminho pedido vai para o log, não para a resposta. O `code` deixa o painel avisar
// que a API está numa versão anterior à dele.
app.use((req: Request, res: Response) => {
  logWarn('app.rotaInexistente', `${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Recurso não encontrado.', code: 'ROTA_INEXISTENTE' });
});

Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

export default app;
