import type { NextFunction, Request, Response } from 'express';
import platformSettingsService from '../services/platformSettings.service';
import { logCtrlError } from '../utils/logger';

export const getPlatformSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await platformSettingsService.get());
  } catch (err) {
    logCtrlError('platformSettings.get', req, err);
    next(err);
  }
};

export const updatePlatformSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const settings = await platformSettingsService.update(
      { workerConcurrency: Number(req.body.workerConcurrency), ratePerMinute: Number(req.body.ratePerMinute) },
      req.user?.email ?? ''
    );
    res.json({ message: 'Ajustes do motor de envio atualizados.', settings });
  } catch (err) {
    logCtrlError('platformSettings.update', req, err);
    next(err);
  }
};
