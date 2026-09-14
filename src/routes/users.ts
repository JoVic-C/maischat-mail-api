import { Router } from 'express';
import { body, param } from 'express-validator';
import * as ctrl from '../controllers/user.controller';
import { EMAIL_NORMALIZE, validate } from '../middleware/validate';

const router = Router();

router.get('/', ctrl.getUsers);

router.post(
  '/save',
  body('id').optional().isMongoId().withMessage('ID inválido.'),
  body('email').isEmail().withMessage('E-mail inválido.').normalizeEmail(EMAIL_NORMALIZE),
  body('name').optional().trim(),
  body('password').optional().isLength({ min: 8 }).withMessage('A senha deve ter ao menos 8 caracteres.'),
  body('role').optional().isIn(['admin', 'user']).withMessage('Papel inválido.'),
  body('isActive').optional().isBoolean().withMessage('isActive deve ser booleano.'),
  validate,
  ctrl.saveUser
);

router.post('/:id/resend-invite', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.resendInvite);

router.post('/:id/reset-link', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.resetLink);

router.post(
  '/:id/revoke-sessions',
  param('id').isMongoId().withMessage('ID inválido.'),
  validate,
  ctrl.revokeUserSessions
);

router.delete('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.deleteUser);

export default router;
