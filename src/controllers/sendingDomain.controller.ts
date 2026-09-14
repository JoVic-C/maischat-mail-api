import type { NextFunction, Request, Response } from 'express';
import sendingDomainService from '../services/sendingDomain.service';
import { logCtrlError } from '../utils/logger';

export const getSendingDomains = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await sendingDomainService.list());
  } catch (err) {
    logCtrlError('sendingDomain.getSendingDomains', req, err);
    next(err);
  }
};

export const verifySendingDomain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const domain = await sendingDomainService.verify(req.params.domain);
    const message = domain.status === 'verified' ? 'Domínio liberado para envio.' : 'O domínio ainda tem pendências.';
    res.json({ message, domain });
  } catch (err) {
    logCtrlError('sendingDomain.verifySendingDomain', req, err);
    next(err);
  }
};
