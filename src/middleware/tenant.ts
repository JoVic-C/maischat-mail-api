import type { RequestHandler } from 'express';
import { runAsSystem, runWithTenant } from '../config/tenantContext';
import Tenant from '../models/Tenant';

/**
 * Abre o contexto do cliente; sempre depois do requireAuth.
 *
 * - usuário e admin → o cliente do próprio usuário
 * - superadmin      → o cliente informado no header `X-Tenant-Id`
 */
export const tenantContext: RequestHandler = async (req, res, next) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Não autenticado.' });
    return;
  }

  if (user.role === 'superadmin') {
    const header = req.header('X-Tenant-Id');
    if (!header) {
      res.status(400).json({
        error: 'Superadmin deve informar o cliente no header X-Tenant-Id para acessar esta rota.',
      });
      return;
    }
    const tenant = await Tenant.findById(header).select('isActive').lean();
    if (!tenant) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }
    if (!tenant.isActive) {
      res.status(403).json({ error: 'Cliente desativado.' });
      return;
    }
    runWithTenant(header, () => next());
    return;
  }

  if (!user.tenantId) {
    res.status(403).json({ error: 'Usuário sem cliente associado.' });
    return;
  }

  runWithTenant(user.tenantId, () => next());
};

/**
 * Sem escopo de cliente, para rotas cujo controle de acesso é outro: tracking público
 * (assinatura HMAC) e webhook (token próprio). Nunca numa rota do painel.
 */
export const systemContext: RequestHandler = (_req, _res, next) => {
  runAsSystem(() => next());
};
