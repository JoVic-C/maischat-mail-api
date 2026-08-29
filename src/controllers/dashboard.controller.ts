import type { NextFunction, Request, Response } from 'express';
import dashboardService from '../services/dashboard.service';
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

export const getActivity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const activity = await dashboardService.getActivity();
    res.json(activity);
  } catch (err) {
    logCtrlError('dashboard.getActivity', req, err);
    next(err);
  }
};
