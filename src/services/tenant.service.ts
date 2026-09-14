import crypto from 'node:crypto';
import { runWithTenant } from '../config/tenantContext';
import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import Campaign from '../models/Campaign';
import Contact from '../models/Contact';
import List from '../models/List';
import Tenant, { type ITenant, type TenantDocument } from '../models/Tenant';
import User, { type UserDocument } from '../models/User';
import { logSideEffect } from '../utils/logger';
import platformSettingsService from './platformSettings.service';
import { deleteAllOfTenant } from './tenantPurge';
import tenantWelcomeService, { type TenantWelcomeResult } from './tenantWelcome.service';

export interface CreateTenantInput {
  name: string;
  slug: string;
  adminEmail: string;
  /** Sem senha, o admin recebe um convite e define a própria. */
  adminPassword?: string;
  adminName?: string;
}

export interface UpdateTenantInput {
  name?: string;
  isActive?: boolean;
  /** 0 significa sem limite próprio. */
  sendingLimits?: { concurrency?: number; ratePerMinute?: number };
}

export interface TenantSummary extends Pick<ITenant, 'name' | 'slug' | 'isActive' | 'sendingLimits'> {
  id: string;
  users: number;
  contacts: number;
  lists: number;
  campaigns: number;
}

export class TenantService {
  async list(): Promise<TenantSummary[]> {
    const tenants = await Tenant.find().sort({ createdAt: -1 }).lean();

    return Promise.all(
      tenants.map(async (t) => {
        const id = String(t._id);
        const [users, contacts, lists, campaigns] = await Promise.all([
          User.countDocuments({ tenantId: t._id }),
          runWithTenant(id, async () => await Contact.countDocuments()),
          runWithTenant(id, async () => await List.countDocuments()),
          runWithTenant(id, async () => await Campaign.countDocuments()),
        ]);
        return {
          id,
          name: t.name,
          slug: t.slug,
          isActive: t.isActive,
          sendingLimits: t.sendingLimits ?? { concurrency: 0, ratePerMinute: 0 },
          users,
          contacts,
          lists,
          campaigns,
        };
      })
    );
  }

  async getById(id: string): Promise<TenantDocument> {
    const tenant = await Tenant.findById(id);
    if (!tenant) throw new NotFoundError('Cliente não encontrado.');
    return tenant;
  }

  async create(
    data: CreateTenantInput
  ): Promise<{ id: string; slug: string; adminEmail: string; welcome?: TenantWelcomeResult }> {
    const slug = data.slug.toLowerCase().trim();
    if (await Tenant.findOne({ slug })) throw new ConflictError('Já existe um cliente com este identificador.');

    const adminEmail = data.adminEmail.toLowerCase().trim();
    const tenant = await Tenant.create({ name: data.name, slug, isActive: true });

    let admin: UserDocument;
    try {
      admin = await User.create({
        tenantId: tenant._id,
        email: adminEmail,
        password: data.adminPassword || crypto.randomBytes(32).toString('base64url'),
        name: data.adminName ?? '',
        role: 'admin',
        isActive: true,
      });
    } catch (err) {
      // Sem admin o cliente ficaria inacessível.
      await tenant.deleteOne();
      throw err;
    }

    // Fora do try acima: falha no email de boas-vindas não desfaz um cliente já utilizável.
    let welcome: TenantWelcomeResult | undefined;
    try {
      welcome = await tenantWelcomeService.send(tenant, admin, Boolean(data.adminPassword));
    } catch (err) {
      logSideEffect('tenant.create.welcome', err, { tenant: slug, adminEmail });
    }

    return { id: String(tenant._id), slug, adminEmail, welcome };
  }

  async update(id: string, data: UpdateTenantInput): Promise<TenantDocument> {
    const tenant = await this.getById(id);
    if (data.name !== undefined) tenant.name = data.name;

    if (data.sendingLimits) {
      // Os limites do cliente são uma fatia do motor; não podem passar do total da plataforma.
      const engine = await platformSettingsService.getEngineSettings();
      const { concurrency, ratePerMinute } = data.sendingLimits;

      if (concurrency !== undefined) {
        if (concurrency > engine.workerConcurrency) {
          throw new BadRequestError(
            `Envios simultâneos do cliente não podem passar do motor da plataforma (${engine.workerConcurrency}).`
          );
        }
        tenant.sendingLimits.concurrency = concurrency;
      }
      if (ratePerMinute !== undefined) {
        if (ratePerMinute > engine.ratePerMinute) {
          throw new BadRequestError(
            `Emails por minuto do cliente não podem passar do motor da plataforma (${engine.ratePerMinute}).`
          );
        }
        tenant.sendingLimits.ratePerMinute = ratePerMinute;
      }
    }

    if (data.isActive !== undefined && data.isActive !== tenant.isActive) {
      tenant.isActive = data.isActive;
      if (!data.isActive) await User.updateMany({ tenantId: tenant._id }, { $inc: { tokenVersion: 1 } });
    }

    await tenant.save();
    return tenant;
  }

  /** Irreversível: exige repetir o slug e o cliente já desativado. */
  async remove(id: string, confirmSlug: string): Promise<{ deleted: Record<string, number> }> {
    const tenant = await this.getById(id);
    if (confirmSlug !== tenant.slug) {
      throw new BadRequestError('Confirmação inválida: repita o identificador (slug) do cliente.');
    }
    if (tenant.isActive) {
      throw new BadRequestError('Desative o cliente antes de excluí-lo.');
    }

    const deleted = await runWithTenant(id, () => deleteAllOfTenant());

    deleted.users = (await User.deleteMany({ tenantId: tenant._id })).deletedCount ?? 0;
    await tenant.deleteOne();
    return { deleted };
  }
}

export default new TenantService();
