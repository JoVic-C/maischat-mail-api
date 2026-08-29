import type { RequestHandler } from 'express';
import { runAsSystem, runWithTenant } from '../config/tenantContext';
import Tenant from '../models/Tenant';

/**
 * Abre o contexto de tenant da requisição. Usar SEMPRE depois do requireAuth:
 * daqui para baixo, toda query em modelo multi-tenant sai filtrada pelo cliente.
 *
 * - usuário comum/admin → o tenant é o do próprio usuário; ele não escolhe.
 * - superadmin          → precisa dizer em qual cliente está operando, pelo
 *                         header `X-Tenant-Id`. Sem isso, só as rotas de
 *                         administração da plataforma (/api/tenants) funcionam.
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
 * Abre o contexto em modo SYSTEM (sem escopo de cliente).
 *
 * Só para rotas que legitimamente não têm um cliente na entrada e cujo controle de
 * acesso é outro: tracking público (assinatura HMAC + ids do envio) e webhook do
 * xMailer (Bearer token próprio). Nunca use numa rota do painel.
 */
export const systemContext: RequestHandler = (_req, _res, next) => {
  runAsSystem(() => next());
};
