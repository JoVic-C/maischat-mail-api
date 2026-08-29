import type { NextFunction, Request, Response } from 'express';
import userService from '../services/user.service';
import { logCtrlError } from '../utils/logger';

export const getUsers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const users = await userService.list();
    res.json(users);
  } catch (err) {
    logCtrlError('user.getUsers', req, err);
    next(err);
  }
};

export const saveUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await userService.save(req.body, String(req.user!._id));
    // O link do convite volta na resposta para o admin poder repassar por outro canal
    // quando o email não sai (cliente ainda sem SMTP configurado, por exemplo).
    res.json({ message: 'Usuário salvo.', ...result });
  } catch (err) {
    logCtrlError('user.saveUser', req, err);
    next(err);
  }
};

export const deleteUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await userService.remove(req.params.id, String(req.user!._id));
    res.status(204).send();
  } catch (err) {
    logCtrlError('user.deleteUser', req, err);
    next(err);
  }
};

export const revokeUserSessions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await userService.revokeSessions(req.params.id);
    res.json({ message: 'Sessões revogadas.' });
  } catch (err) {
    logCtrlError('user.revokeUserSessions', req, err);
    next(err);
  }
};

export const resendInvite = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const invite = await userService.resendInvite(req.params.id);
    res.json({ message: invite.emailSent ? 'Convite reenviado por email.' : 'Convite gerado.', invite });
  } catch (err) {
    logCtrlError('user.resendInvite', req, err);
    next(err);
  }
};

export const resetLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reset = await userService.issueResetLink(req.params.id);
    res.json({
      message: reset.emailSent ? 'Link enviado por email.' : 'Link gerado (o email não pôde ser enviado).',
      reset,
    });
  } catch (err) {
    logCtrlError('user.resetLink', req, err);
    next(err);
  }
};
