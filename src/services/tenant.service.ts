import crypto from 'node:crypto';
import { runWithTenant } from '../config/tenantContext';
import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import Campaign from '../models/Campaign';
import Contact from '../models/Contact';
import List from '../models/List';
import Tenant, { type ITenant, type TenantDocument } from '../models/Tenant';
import User from '../models/User';
import inviteService, { type InviteLink } from './invite.service';
import platformSettingsService from './platformSettings.service';
import { deleteAllOfTenant } from './tenantPurge';

export interface CreateTenantInput {
  name: string;
  slug: string;
  /** Primeiro administrador do cliente — criado junto, senão ninguém consegue entrar. */
  adminEmail: string;
  /** Opcional: sem senha, o admin recebe um convite e define a própria. É o padrão. */
  adminPassword?: string;
  adminName?: string;
}

export interface UpdateTenantInput {
  name?: string;
  isActive?: boolean;
  /** Fatia da capacidade do motor reservada a este cliente. 0 = sem limite próprio. */
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

    // Os contadores de cada cliente são lidos DENTRO do escopo dele — a mesma
    // barreira que vale para o resto da aplicação vale aqui.
    return Promise.all(
      tenants.map(async (t) => {
        const id = String(t._id);
        const [users, contacts, lists, campaigns] = await Promise.all([
          User.countDocuments({ tenantId: t._id }),
          // O await precisa acontecer DENTRO do runWithTenant: uma Query do Mongoose
          // só executa quando é aguardada, e fora do escopo o contexto já não existe.
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

  /** Cria o cliente e o primeiro admin dele, numa operação só. */
  async create(
    data: CreateTenantInput
  ): Promise<{ id: string; slug: string; adminEmail: string; invite?: InviteLink & { emailSent: boolean } }> {
    const slug = data.slug.toLowerCase().trim();
    if (await Tenant.findOne({ slug })) throw new ConflictError('Já existe um cliente com este identificador.');

    const adminEmail = data.adminEmail.toLowerCase().trim();
    const tenant = await Tenant.create({ name: data.name, slug, isActive: true });

    try {
      const admin = await User.create({
        tenantId: tenant._id,
        email: adminEmail,
        // Sem senha informada, entra um placeholder aleatório que o convite substitui.
        password: data.adminPassword || crypto.randomBytes(32).toString('base64url'),
        name: data.adminName ?? '',
        role: 'admin',
        isActive: true,
      });

      const invite = data.adminPassword ? undefined : await inviteService.issueAndSend(admin);
      return { id: String(tenant._id), slug, adminEmail, invite };
    } catch (err) {
      // Sem admin o cliente nasce inacessível — desfaz para não deixar lixo.
      await tenant.deleteOne();
      throw err;
    }
  }

  async update(id: string, data: UpdateTenantInput): Promise<TenantDocument> {
    const tenant = await this.getById(id);
    if (data.name !== undefined) tenant.name = data.name;

    if (data.sendingLimits) {
      // Os limites do cliente são uma FATIA da piscina do motor: não podem prometer
      // mais do que a plataforma inteira comporta, senão viram número decorativo.
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
      // Desativar o cliente derruba as sessões de todos os usuários dele.
      if (!data.isActive) await User.updateMany({ tenantId: tenant._id }, { $inc: { tokenVersion: 1 } });
    }

    await tenant.save();
    return tenant;
  }

  /**
   * Exclusão de cliente é destrutiva e irreversível: exige confirmação explícita
   * do slug, para não apagar a base errada.
   */
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
