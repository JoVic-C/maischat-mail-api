import { getTenantContext } from '../config/tenantContext';
import Campaign from '../models/Campaign';
import Contact from '../models/Contact';
import SendLog from '../models/SendLog';
import { logWarn } from '../utils/logger';

export class BounceService {
  /**
   * Marca um bounce.
   *
   * Chamado de dois lugares com contextos diferentes:
   * - worker / rota admin → já está no escopo de um cliente; tudo é filtrado sozinho.
   * - webhook do xMailer  → modo system, sem cliente na entrada. Aí o envio (SendLog)
   *   é a única âncora confiável: dele sai o tenantId, e só o contato DAQUELE cliente
   *   é marcado. Sem isso, um email presente em dois clientes bloquearia o contato errado.
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
      // Sem envio correspondente não há como saber de qual cliente é o endereço.
      logWarn('bounce.processBounce', `sem envio correspondente para ${normalized} — nenhum contato marcado`);
      return { email: normalized, contactMarked: false };
    }

    // Em modo system o filtro por tenant é explícito (vem do envio encontrado);
    // no escopo de um cliente o plugin já cuida disso.
    const contactFilter = isSystem && log ? { email: normalized, tenantId: log.tenantId } : { email: normalized };
    const contact = await Contact.findOne(contactFilter);

    if (contact && contact.status !== 'bounced') {
      contact.status = 'bounced';
      await contact.save();
    }

    if (log && log.status !== 'bounced') {
      log.status = 'bounced';
      log.error = reason; // motivo real do bounce (SMTP, webhook) ou "simulado" no teste
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
