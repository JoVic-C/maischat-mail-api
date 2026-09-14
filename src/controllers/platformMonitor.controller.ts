import type { NextFunction, Request, Response } from 'express';
import platformMonitorService from '../services/platformMonitor.service';
import { logCtrlError } from '../utils/logger';

export const getOverview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [queue, tenants] = await Promise.all([
      platformMonitorService.getQueueState(),
      platformMonitorService.getTenantActivity(Number(req.query.hours) || 24),
    ]);
    res.json({ queue, tenants });
  } catch (err) {
    logCtrlError('platformMonitor.getOverview', req, err);
    next(err);
  }
};

/** Últimas falhas de todos os clientes — expõe dado pessoal, então é auditado. */
export const getFailures = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const failures = await platformMonitorService.getRecentFailures(Number(req.query.limit) || 50, {
      actorEmail: req.user!.email,
      actorId: req.user!._id,
      ip: req.ip ?? '',
    });
    res.json(failures);
  } catch (err) {
    logCtrlError('platformMonitor.getFailures', req, err);
    next(err);
  }
};
