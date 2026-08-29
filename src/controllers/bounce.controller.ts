import type { NextFunction, Request, Response } from 'express';
import bounceService from '../services/bounce.service';
import { logCtrlError } from '../utils/logger';

export const reportBounce = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await bounceService.processBounce(
      req.body.email,
      req.body.campaignId,
      req.body.reason || 'Bounce simulado (teste)'
    );
    res.json({ message: `Bounce registrado para ${result.email}.`, ...result });
  } catch (err) {
    logCtrlError('bounce.reportBounce', req, err);
    next(err);
  }
};
