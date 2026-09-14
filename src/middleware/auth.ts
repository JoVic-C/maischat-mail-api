import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User';

import type { JwtPayload } from '../services/auth.service';

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
    // Token emitido antes do último logout-all ou troca de senha; `?? 0` cobre tokens anteriores ao campo.
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

/** Depois do requireAuth. O superadmin passa, dentro do cliente informado em X-Tenant-Id. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' });
    return;
  }
  next();
};

export const requireSuperadmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'superadmin') {
    res.status(403).json({ error: 'Acesso restrito à administração da plataforma.' });
    return;
  }
  next();
};
