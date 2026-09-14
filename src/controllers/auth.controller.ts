import type { NextFunction, Request, Response } from 'express';
import authService from '../services/auth.service';
import inviteService from '../services/invite.service';
import passwordResetService from '../services/passwordReset.service';
import { logCtrlError } from '../utils/logger';

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await authService.login(req.body.email, req.body.password);
    res.json(result);
  } catch (err) {
    logCtrlError('auth.login', req, err);
    next(err);
  }
};

export const getCurrentUser = async (req: Request, res: Response): Promise<void> => {
  res.json(authService.toPublicUser(req.user!));
};

export const logoutAll = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await authService.revokeSessions(String(req.user!._id));
    res.json({ message: 'Sessões encerradas em todos os dispositivos.' });
  } catch (err) {
    logCtrlError('auth.logoutAll', req, err);
    next(err);
  }
};

export const changePassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await authService.changePassword(
      String(req.user!._id),
      req.body.currentPassword,
      req.body.newPassword
    );
    res.json({ message: 'Senha alterada.', ...result });
  } catch (err) {
    logCtrlError('auth.changePassword', req, err);
    next(err);
  }
};

export const getInvite = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await inviteService.preview(String(req.query.token || '')));
  } catch (err) {
    logCtrlError('auth.getInvite', req, err);
    next(err);
  }
};

export const acceptInvite = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await inviteService.accept(req.body.token, req.body.password);
    res.json({ message: 'Senha definida. Bem-vindo!', ...result });
  } catch (err) {
    logCtrlError('auth.acceptInvite', req, err);
    next(err);
  }
};

/** Mesma resposta exista o email ou não, para a rota não servir de enumeração de contas. */
export const forgotPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await passwordResetService.requestByEmail(req.body.email);
    res.json({ message: 'Se existir uma conta com este email, enviamos o link para redefinir a senha.' });
  } catch (err) {
    logCtrlError('auth.forgotPassword', req, err);
    next(err);
  }
};

export const getReset = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await passwordResetService.preview(String(req.query.token || '')));
  } catch (err) {
    logCtrlError('auth.getReset', req, err);
    next(err);
  }
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await passwordResetService.reset(req.body.token, req.body.password);
    res.json({ message: 'Senha redefinida.', ...result });
  } catch (err) {
    logCtrlError('auth.resetPassword', req, err);
    next(err);
  }
};
