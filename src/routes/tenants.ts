import { Router } from 'express';
import { body, param } from 'express-validator';
import * as ctrl from '../controllers/tenant.controller';
import { EMAIL_NORMALIZE, validate } from '../middleware/validate';

const router = Router();

// Acima dos clientes: sem tenantContext.

router.get('/', ctrl.getTenants);

router.post(
  '/',
  body('name').trim().isLength({ min: 2 }).withMessage('Nome deve ter ao menos 2 caracteres.'),
  body('slug')
    .trim()
    .matches(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/)
    .withMessage('Identificador deve ter 3-40 caracteres: letras minúsculas, números e hífen.'),
  body('adminEmail').isEmail().withMessage('E-mail do admin inválido.').normalizeEmail(EMAIL_NORMALIZE),
  body('adminPassword').optional().isLength({ min: 8 }).withMessage('A senha do admin deve ter ao menos 8 caracteres.'),
  body('adminName').optional().trim(),
  validate,
  ctrl.createTenant
);

router.put(
  '/:id',
  param('id').isMongoId().withMessage('ID inválido.'),
  body('name').optional().trim().isLength({ min: 2 }).withMessage('Nome deve ter ao menos 2 caracteres.'),
  body('isActive').optional().isBoolean().withMessage('isActive deve ser booleano.'),
  body('sendingLimits.concurrency')
    .optional()
    .isInt({ min: 0, max: 50 })
    .withMessage('Envios simultâneos deve ser um número entre 0 e 50.'),
  body('sendingLimits.ratePerMinute')
    .optional()
    .isInt({ min: 0, max: 100000 })
    .withMessage('Emails por minuto deve ser um número entre 0 e 100000.'),
  validate,
  ctrl.updateTenant
);

router.delete(
  '/:id',
  param('id').isMongoId().withMessage('ID inválido.'),
  body('confirmSlug').isString().notEmpty().withMessage('Confirme repetindo o identificador do cliente.'),
  validate,
  ctrl.deleteTenant
);

export default router;
