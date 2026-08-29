import Campaign, { type ICampaign } from '../models/Campaign';
import Contact from '../models/Contact';
import List from '../models/List';
import SendLog from '../models/SendLog';

export interface DashboardStats {
  totalContacts: number;
  activeContacts: number;
  totalLists: number;
  totalCampaigns: number;
  emailsSent: number;
  openRate: number;
  clickRate: number;
  recentCampaigns: ICampaign[];
}

export interface ActivityPoint {
  date: string;
  sent: number;
  opened: number;
  clicked: number;
  failed: number;
}

export class DashboardService {
  async getStats(): Promise<DashboardStats> {
    const [totalContacts, activeContacts, totalLists, totalCampaigns, totals, recentCampaigns] = await Promise.all([
      Contact.countDocuments(),
      Contact.countDocuments({ status: 'active' }),
      List.countDocuments(),
      Campaign.countDocuments(),
      // Os totais saem das métricas já agregadas em Campaign.stats (uma collection pequena),
      // em vez de varrer o SendLog inteiro — que cresce 1 documento por email enviado.
      Campaign.aggregate<{ sent: number; opened: number; clicked: number }>([
        {
          $group: {
            _id: null,
            sent: { $sum: '$stats.sent' },
            opened: { $sum: '$stats.opened' },
            clicked: { $sum: '$stats.clicked' },
          },
        },
      ]),
      Campaign.find().sort({ createdAt: -1 }).limit(5).lean(),
    ]);

    const emailsSent = totals[0]?.sent ?? 0;
    const emailsOpened = totals[0]?.opened ?? 0;
    const emailsClicked = totals[0]?.clicked ?? 0;

    const rate = (part: number) => (emailsSent ? Math.round((part / emailsSent) * 1000) / 10 : 0);
    return {
      totalContacts,
      activeContacts,
      totalLists,
      totalCampaigns,
      emailsSent,
      openRate: rate(emailsOpened),
      clickRate: rate(emailsClicked),
      recentCampaigns,
    };
  }

  async getActivity(): Promise<ActivityPoint[]> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await SendLog.aggregate<{ _id: string } & Omit<ActivityPoint, 'date'>>([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          sent: { $sum: { $cond: [{ $ne: ['$sentAt', null] }, 1, 0] } },
          opened: { $sum: { $cond: [{ $ne: ['$openedAt', null] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return rows.map((r) => ({ date: r._id, sent: r.sent, opened: r.opened, clicked: r.clicked, failed: r.failed }));
  }
}

export default new DashboardService();
