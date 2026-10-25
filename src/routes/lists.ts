import { Router } from 'express';
import { body, param, query } from 'express-validator';
import * as ctrl from '../controllers/list.controller';
import * as ctrlVerification from '../controllers/verification.controller';
import { requireAdmin } from '../middleware/auth';
import { importProgressLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';

const router = Router();

router.get(
  '/',
  query('search').optional().trim(),
  query('type').optional().isIn(['public', 'private']).withMessage('Tipo inválido.'),
  validate,
  ctrl.getLists
);

router.get('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.getList);

// A tela consulta em intervalos enquanto o provedor verifica: limite próprio, fora da cota geral.
router.get(
  '/:id/verification',
  importProgressLimiter,
  param('id').isMongoId().withMessage('ID inválido.'),
  validate,
  ctrlVerification.getListVerification
);

// Gasta créditos pagos: só administradores.
router.post(
  '/:id/verify',
  requireAdmin,
  param('id').isMongoId().withMessage('ID inválido.'),
  validate,
  ctrlVerification.startListVerification
);

router.post(
  '/',
  body('name').trim().isLength({ min: 2 }).withMessage('Nome deve ter ao menos 2 caracteres.'),
  body('description').optional().trim(),
  body('type').optional().isIn(['public', 'private']).withMessage('Tipo inválido.'),
  body('tags').optional().isArray().withMessage('Tags deve ser uma lista.'),
  validate,
  ctrl.createList
);

router.put(
  '/:id',
  param('id').isMongoId().withMessage('ID inválido.'),
  body('name').optional().trim().isLength({ min: 2 }).withMessage('Nome deve ter ao menos 2 caracteres.'),
  body('description').optional().trim(),
  body('type').optional().isIn(['public', 'private']).withMessage('Tipo inválido.'),
  body('tags').optional().isArray().withMessage('Tags deve ser uma lista.'),
  validate,
  ctrl.updateList
);

router.delete('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.deleteList);

router.post(
  '/save',
  body('id').optional().isMongoId().withMessage('ID inválido.'),
  body('name').trim().isLength({ min: 2 }).withMessage('Nome deve ter ao menos 2 caracteres.'),
  body('description').optional().trim(),
  body('type').optional().isIn(['public', 'private']).withMessage('Tipo inválido.'),
  body('tags').optional().isArray().withMessage('Tags deve ser uma lista.'),
  validate,
  ctrl.saveList
);

router.post('/resync-counts', ctrl.resyncListCounts);

export default router;
