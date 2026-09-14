import Campaign, { type ICampaign } from '../models/Campaign';
import Contact from '../models/Contact';
import List from '../models/List';

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

export class DashboardService {
  async getStats(): Promise<DashboardStats> {
    const [totalContacts, activeContacts, totalLists, totalCampaigns, totals, recentCampaigns] = await Promise.all([
      Contact.countDocuments(),
      Contact.countDocuments({ status: 'active' }),
      List.countDocuments(),
      Campaign.countDocuments(),
      // Soma de Campaign.stats, em vez de varrer o SendLog, que tem um documento por email.
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
}

export default new DashboardService();
