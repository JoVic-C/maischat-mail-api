import type { NextFunction, Request, Response } from 'express';
import emailVerificationService from '../services/emailVerification.service';
import { logCtrlError } from '../utils/logger';

export const getListVerification = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await emailVerificationService.overview(req.params.id));
  } catch (err) {
    logCtrlError('verification.getListVerification', req, err);
    next(err);
  }
};

/** Só enfileira: o provedor verifica a lista de forma assíncrona. */
export const startListVerification = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const job = await emailVerificationService.startListVerification(req.params.id, String(req.user?.id));
    res.status(202).json({ message: 'Verificação iniciada.', job });
  } catch (err) {
    logCtrlError('verification.startListVerification', req, err);
    next(err);
  }
};
