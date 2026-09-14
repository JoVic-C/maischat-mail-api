import { getTenantContext } from '../config/tenantContext';
import Campaign from '../models/Campaign';
import Contact from '../models/Contact';
import SendLog from '../models/SendLog';
import { logWarn } from '../utils/logger';

export class BounceService {
  /**
   * Vindo do webhook (modo system), o envio é a única âncora de qual cliente é o endereço:
   * sem ela, um email presente em dois clientes bloquearia o contato errado.
   */
  async processBounce(
    email: string,
    campaignId?: string,
    reason = 'Bounce reportado'
  ): Promise<{ email: string; contactMarked: boolean }> {
    const normalized = email.toLowerCase().trim();

    const query = campaignId ? { campaignId, email: normalized } : { email: normalized };
    const log = await SendLog.findOne(query).sort({ createdAt: -1 });

    const isSystem = getTenantContext()?.mode === 'system';
    if (isSystem && !log) {
      logWarn('bounce.processBounce', `sem envio correspondente para ${normalized} — nenhum contato marcado`);
      return { email: normalized, contactMarked: false };
    }

    // No modo system o filtro por cliente vem do envio; no escopo de um cliente, o plugin cuida.
    const contactFilter = isSystem && log ? { email: normalized, tenantId: log.tenantId } : { email: normalized };
    const contact = await Contact.findOne(contactFilter);

    if (contact && contact.status !== 'bounced') {
      contact.status = 'bounced';
      await contact.save();
    }

    if (log && log.status !== 'bounced') {
      log.status = 'bounced';
      log.error = reason;
      await log.save();
      await Campaign.updateOne({ _id: log.campaignId }, { $inc: { 'stats.bounced': 1 } });
    }

    return { email: normalized, contactMarked: !!contact };
  }

  async processSoftBounce(email: string, reason = ''): Promise<{ email: string }> {
    const normalized = email.toLowerCase().trim();
    const log = await SendLog.findOne({ email: normalized }).sort({ createdAt: -1 });
    if (log) {
      log.error = `Soft bounce (temporário): ${reason || 'falha temporária'}`;
      await log.save();
    }
    return { email: normalized };
  }
}

export default new BounceService();
