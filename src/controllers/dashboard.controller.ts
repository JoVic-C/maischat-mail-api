import type { NextFunction, Request, Response } from 'express';
import dashboardService from '../services/dashboard.service';
import sendReportService, { type Agrupamento } from '../services/sendReport.service';
import { logCtrlError } from '../utils/logger';

export const getStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const stats = await dashboardService.getStats();
    res.json(stats);
  } catch (err) {
    logCtrlError('dashboard.getStats', req, err);
    next(err);
  }
};

export const getSendReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { de, ate, agrupamento } = req.query as Record<string, string | undefined>;
    res.json(await sendReportService.gerar({ de, ate, agrupamento: agrupamento as Agrupamento | undefined }));
  } catch (err) {
    logCtrlError('dashboard.getSendReport', req, err);
    next(err);
  }
};
