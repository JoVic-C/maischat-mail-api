import type { NextFunction, Request, Response } from 'express';
import smtpService from '../services/smtp.service';
import { logCtrlError } from '../utils/logger';

export const getSmtpServers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const servers = await smtpService.list();
    res.json(servers);
  } catch (err) {
    logCtrlError('smtp.getSmtpServers', req, err);
    next(err);
  }
};

export const saveSmtp = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const server = await smtpService.save(req.body);
    res.json({ message: 'Servidor SMTP salvo.', server });
  } catch (err) {
    logCtrlError('smtp.saveSmtp', req, err);
    next(err);
  }
};

export const deleteSmtp = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await smtpService.remove(req.params.id);
    res.status(204).send();
  } catch (err) {
    logCtrlError('smtp.deleteSmtp', req, err);
    next(err);
  }
};

export const testConnection = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await smtpService.testConnection(req.body);
    res.json({ message: 'Conexão bem-sucedida', ...result });
  } catch (err) {
    logCtrlError('smtp.testConnection', req, err);
    next(err);
  }
};

export const sendTestEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { from, to, ...creds } = req.body;
    const result = await smtpService.sendTestEmail(creds, from, to);
    res.json({ message: `Email de teste enviado para ${to}.`, ...result });
  } catch (err) {
    logCtrlError('smtp.sendTestEmail', req, err);
    next(err);
  }
};
