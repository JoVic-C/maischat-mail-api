import type { NextFunction, Request, Response } from 'express';
import tenantService from '../services/tenant.service';
import { logCtrlError } from '../utils/logger';

export const getTenants = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await tenantService.list());
  } catch (err) {
    logCtrlError('tenant.getTenants', req, err);
    next(err);
  }
};

export const createTenant = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenant = await tenantService.create(req.body);

    // O email é best-effort: a mensagem avisa quando o admin não recebeu nada.
    const message = tenant.welcome?.emailSent
      ? `Cliente criado. Email de boas-vindas enviado para ${tenant.adminEmail}.`
      : 'Cliente criado, mas o email de boas-vindas não pôde ser enviado. Repasse o link de acesso ao administrador.';

    res.status(201).json({ message, tenant });
  } catch (err) {
    logCtrlError('tenant.createTenant', req, err);
    next(err);
  }
};

export const updateTenant = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenant = await tenantService.update(req.params.id, req.body);
    res.json({ message: 'Cliente atualizado.', tenant });
  } catch (err) {
    logCtrlError('tenant.updateTenant', req, err);
    next(err);
  }
};

export const deleteTenant = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await tenantService.remove(req.params.id, req.body.confirmSlug);
    res.json({ message: 'Cliente e todos os seus dados foram excluídos.', ...result });
  } catch (err) {
    logCtrlError('tenant.deleteTenant', req, err);
    next(err);
  }
};
