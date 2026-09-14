import type { Types } from 'mongoose';
import { runAsSystem } from '../config/tenantContext';
import AuditLog from '../models/AuditLog';
import Campaign from '../models/Campaign';
import SendLog from '../models/SendLog';
import Tenant from '../models/Tenant';
import { emailQueue } from '../queue/email.queue';
import { schedulerQueue } from '../queue/scheduler.queue';

/**
 * Operação da plataforma inteira, só para superadmin. As leituras atravessam clientes em
 * `runAsSystem()`; em qualquer outra parte do painel, query sem escopo é bug.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface QueueState {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  scheduled: number;
}

export interface TenantActivity {
  tenantId: string;
  name: string;
  slug: string;
  isActive: boolean;
  sent: number;
  failed: number;
  bounced: number;
  sending: number;
  paused: number;
}

export interface FailureRow {
  tenantName: string;
  campaignId: string;
  email: string;
  status: string;
  error: string;
  at: Date;
}

interface AuditContext {
  actorEmail: string;
  actorId: Types.ObjectId | string | null;
  ip: string;
}

export class PlatformMonitorService {
  async getQueueState(): Promise<QueueState> {
    const [email, scheduler] = await Promise.all([
      emailQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      schedulerQueue.getJobCounts('delayed'),
    ]);

    return {
      waiting: email.waiting ?? 0,
      active: email.active ?? 0,
      delayed: email.delayed ?? 0,
      failed: email.failed ?? 0,
      scheduled: scheduler.delayed ?? 0,
    };
  }

  /** Só números: nenhum endereço de destinatário sai daqui. */
  async getTenantActivity(hours = 24): Promise<TenantActivity[]> {
    const since = new Date(Date.now() - (hours / 24) * DAY_MS);

    return runAsSystem(async () => {
      const [tenants, envios, campanhas] = await Promise.all([
        Tenant.find().select('name slug isActive').lean(),
        SendLog.aggregate<{ _id: Types.ObjectId; sent: number; failed: number; bounced: number }>([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: '$tenantId',
              sent: { $sum: { $cond: [{ $ne: ['$sentAt', null] }, 1, 0] } },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
              bounced: { $sum: { $cond: [{ $eq: ['$status', 'bounced'] }, 1, 0] } },
            },
          },
        ]),
        Campaign.aggregate<{ _id: Types.ObjectId; sending: number; paused: number }>([
          { $match: { status: { $in: ['sending', 'paused'] } } },
          {
            $group: {
              _id: '$tenantId',
              sending: { $sum: { $cond: [{ $eq: ['$status', 'sending'] }, 1, 0] } },
              paused: { $sum: { $cond: [{ $eq: ['$status', 'paused'] }, 1, 0] } },
            },
          },
        ]),
      ]);

      const porEnvio = new Map(envios.map((e) => [String(e._id), e]));
      const porCampanha = new Map(campanhas.map((c) => [String(c._id), c]));

      return tenants
        .map((t) => {
          const id = String(t._id);
          const e = porEnvio.get(id);
          const c = porCampanha.get(id);
          return {
            tenantId: id,
            name: t.name,
            slug: t.slug,
            isActive: t.isActive,
            sent: e?.sent ?? 0,
            failed: e?.failed ?? 0,
            bounced: e?.bounced ?? 0,
            sending: c?.sending ?? 0,
            paused: c?.paused ?? 0,
          };
        })
        .sort((a, b) => b.sending - a.sending || b.failed + b.bounced - (a.failed + a.bounced) || b.sent - a.sent);
    });
  }

  /** Expõe endereços de contatos dos clientes, por isso todo acesso vai para o AuditLog. */
  async getRecentFailures(limit: number, audit: AuditContext): Promise<FailureRow[]> {
    const capped = Math.min(200, Math.max(1, limit));

    const rows = await runAsSystem(async () => {
      const logs = await SendLog.find({ status: { $in: ['failed', 'bounced'] } })
        .select('tenantId campaignId email status error updatedAt')
        .sort({ updatedAt: -1 })
        .limit(capped)
        .lean<
          {
            tenantId: Types.ObjectId;
            campaignId: Types.ObjectId;
            email: string;
            status: string;
            error: string;
            updatedAt: Date;
          }[]
        >();

      if (!logs.length) return [];

      const tenantIds = [...new Set(logs.map((l) => String(l.tenantId)))];
      const tenants = await Tenant.find({ _id: { $in: tenantIds } })
        .select('name')
        .lean();
      const nomes = new Map(tenants.map((t) => [String(t._id), t.name]));

      return logs.map((l) => ({
        tenantName: nomes.get(String(l.tenantId)) ?? '—',
        campaignId: String(l.campaignId),
        email: l.email,
        status: l.status,
        error: l.error,
        at: l.updatedAt,
      }));
    });

    await AuditLog.create({
      actorEmail: audit.actorEmail,
      actorId: audit.actorId,
      action: 'platform.failures.read',
      tenantId: null,
      detail: `${rows.length} registro(s) de falha consultados`,
      ip: audit.ip,
    });

    return rows;
  }
}

export default new PlatformMonitorService();
