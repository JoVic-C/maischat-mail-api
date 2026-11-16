import type { NextFunction, Request, Response } from 'express';
import emailTypoService from '../services/emailTypo.service';
import { logCtrlError } from '../utils/logger';

export const getEmailSuggestion = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Minúsculas, como o contato é gravado.
    const email = String(req.query.email ?? '').toLowerCase();
    const domain = await emailTypoService.suggestionFor(email);
    const at = email.lastIndexOf('@');
    res.json({ suggestion: domain ? `${email.slice(0, at)}@${domain}` : null });
  } catch (err) {
    logCtrlError('typoDomain.getEmailSuggestion', req, err);
    next(err);
  }
};

export const listTypoDomains = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json({ domains: await emailTypoService.listSuspects() });
  } catch (err) {
    logCtrlError('typoDomain.listTypoDomains', req, err);
    next(err);
  }
};

export const fixTypoDomain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await emailTypoService.fixDomain(req.body.from, req.body.to);
    res.json({ message: `${result.fixed} contato(s) corrigido(s).`, ...result });
  } catch (err) {
    logCtrlError('typoDomain.fixTypoDomain', req, err);
    next(err);
  }
};

export const acceptTypoDomain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await emailTypoService.acceptDomain(req.body.domain, req.user?._id ? String(req.user._id) : null);
    res.json({ message: 'Domínio mantido.', ...result });
  } catch (err) {
    logCtrlError('typoDomain.acceptTypoDomain', req, err);
    next(err);
  }
};
