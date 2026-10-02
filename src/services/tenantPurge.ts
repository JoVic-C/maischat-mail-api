/**
 * Remoção total dos dados de um cliente. Precisa rodar dentro de `runWithTenant(id, ...)`:
 * cada deleteMany sai escopado pelo plugin e não alcança outro cliente.
 */
import Campaign from '../models/Campaign';
import Contact from '../models/Contact';
import FormSubmission from '../models/FormSubmission';
import FormWebhook from '../models/FormWebhook';
import List from '../models/List';
import Segment from '../models/Segment';
import SendingDomain from '../models/SendingDomain';
import SendLog from '../models/SendLog';
import SmtpSettings from '../models/SmtpSettings';
import Template from '../models/Template';

export async function deleteAllOfTenant(): Promise<Record<string, number>> {
  const [
    sendLogs,
    campaigns,
    contacts,
    lists,
    templates,
    segments,
    smtp,
    sendingDomains,
    formWebhooks,
    formSubmissions,
  ] = await Promise.all([
    SendLog.deleteMany({}),
    Campaign.deleteMany({}),
    Contact.deleteMany({}),
    List.deleteMany({}),
    Template.deleteMany({}),
    Segment.deleteMany({}),
    SmtpSettings.deleteMany({}),
    SendingDomain.deleteMany({}),
    FormWebhook.deleteMany({}),
    FormSubmission.deleteMany({}),
  ]);

  return {
    sendLogs: sendLogs.deletedCount ?? 0,
    campaigns: campaigns.deletedCount ?? 0,
    contacts: contacts.deletedCount ?? 0,
    lists: lists.deletedCount ?? 0,
    templates: templates.deletedCount ?? 0,
    segments: segments.deletedCount ?? 0,
    smtp: smtp.deletedCount ?? 0,
    sendingDomains: sendingDomains.deletedCount ?? 0,
    formWebhooks: formWebhooks.deletedCount ?? 0,
    formSubmissions: formSubmissions.deletedCount ?? 0,
  };
}
