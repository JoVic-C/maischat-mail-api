import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User';

import type { JwtPayload } from '../services/auth.service';

/** Exige um JWT válido (Authorization: Bearer <token>). Popula req.user. */
export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Token não fornecido.' });
      return;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload;
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      res.status(401).json({ error: 'Usuário não encontrado.' });
      return;
    }
    if (!user.isActive) {
      res.status(403).json({ error: 'Conta desativada.' });
      return;
    }
    // Revogação: tokens emitidos antes do último logout-all/troca de senha têm `v` defasado.
    // `?? 0` cobre os tokens emitidos antes deste campo existir.
    if ((decoded.v ?? 0) !== user.tokenVersion) {
      res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
};

/**
 * Exige papel de administração — usar SEMPRE depois de requireAuth.
 * O superadmin passa porque administra qualquer cliente (dentro do tenant que
 * ele informar no header X-Tenant-Id, conforme o middleware tenantContext).
 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' });
    return;
  }
  next();
};

/** Exige superadmin — administração da própria plataforma (criar/gerir clientes). */
export const requireSuperadmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'superadmin') {
    res.status(403).json({ error: 'Acesso restrito à administração da plataforma.' });
    return;
  }
  next();
};
