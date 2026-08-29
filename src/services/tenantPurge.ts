/**
 * Remoção total dos dados de um cliente.
 *
 * Precisa rodar DENTRO de `runWithTenant(id, ...)`: cada deleteMany abaixo sai
 * escopado pelo plugin, então não há como apagar a base de outro cliente por
 * engano. Fica em arquivo próprio para deixar explícito o que é destrutivo.
 */
import Campaign from '../models/Campaign';
import Contact from '../models/Contact';
import List from '../models/List';
import Segment from '../models/Segment';
import SendLog from '../models/SendLog';
import SmtpSettings from '../models/SmtpSettings';
import Template from '../models/Template';

export async function deleteAllOfTenant(): Promise<Record<string, number>> {
  const [sendLogs, campaigns, contacts, lists, templates, segments, smtp] = await Promise.all([
    SendLog.deleteMany({}),
    Campaign.deleteMany({}),
    Contact.deleteMany({}),
    List.deleteMany({}),
    Template.deleteMany({}),
    Segment.deleteMany({}),
    SmtpSettings.deleteMany({}),
  ]);

  return {
    sendLogs: sendLogs.deletedCount ?? 0,
    campaigns: campaigns.deletedCount ?? 0,
    contacts: contacts.deletedCount ?? 0,
    lists: lists.deletedCount ?? 0,
    templates: templates.deletedCount ?? 0,
    segments: segments.deletedCount ?? 0,
    smtp: smtp.deletedCount ?? 0,
  };
}
