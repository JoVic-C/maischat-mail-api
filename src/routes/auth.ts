import { Router } from 'express';
import { body, query } from 'express-validator';
import * as ctrl from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import { EMAIL_NORMALIZE, validate } from '../middleware/validate';

const router = Router();

router.post(
  '/login',
  authLimiter,
  body('email').isEmail().withMessage('E-mail inválido.').normalizeEmail(EMAIL_NORMALIZE),
  body('password').notEmpty().withMessage('Senha obrigatória.'),
  validate,
  ctrl.login
);

// Convite e recuperação são públicos; o authLimiter freia a varredura de tokens.
router.get(
  '/invite',
  authLimiter,
  query('token').isString().notEmpty().withMessage('Convite inválido.'),
  validate,
  ctrl.getInvite
);

router.post(
  '/invite/accept',
  authLimiter,
  body('token').isString().notEmpty().withMessage('Convite inválido.'),
  body('password').isLength({ min: 8 }).withMessage('A senha deve ter ao menos 8 caracteres.'),
  validate,
  ctrl.acceptInvite
);

router.post(
  '/forgot-password',
  authLimiter,
  body('email').isEmail().withMessage('Informe um email válido.').normalizeEmail(EMAIL_NORMALIZE),
  validate,
  ctrl.forgotPassword
);

router.get(
  '/reset',
  authLimiter,
  query('token').isString().notEmpty().withMessage('Link inválido.'),
  validate,
  ctrl.getReset
);

router.post(
  '/reset',
  authLimiter,
  body('token').isString().notEmpty().withMessage('Link inválido.'),
  body('password').isLength({ min: 8 }).withMessage('A senha deve ter ao menos 8 caracteres.'),
  validate,
  ctrl.resetPassword
);

router.get('/me', requireAuth, ctrl.getCurrentUser);

router.post('/logout-all', requireAuth, ctrl.logoutAll);

router.post(
  '/change-password',
  requireAuth,
  authLimiter,
  body('currentPassword').notEmpty().withMessage('Senha atual obrigatória.'),
  body('newPassword').isLength({ min: 8 }).withMessage('A nova senha deve ter ao menos 8 caracteres.'),
  validate,
  ctrl.changePassword
);

export default router;
