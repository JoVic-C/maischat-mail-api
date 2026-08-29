import { Router } from 'express';
import { body, param } from 'express-validator';
import * as ctrl from '../controllers/segment.controller';
import { validate } from '../middleware/validate';

const router = Router();

router.get('/', ctrl.getSegments);

router.post(
  '/save',
  body('id').optional().isMongoId().withMessage('ID inválido.'),
  body('name').trim().isLength({ min: 2 }).withMessage('Nome deve ter ao menos 2 caracteres.'),
  body('rules').isArray({ min: 1 }).withMessage('Adicione ao menos uma regra.'),
  body('rules.*.field').trim().notEmpty().withMessage('Campo da regra obrigatório.'),
  body('rules.*.operator').isIn(['equals', 'contains']).withMessage('Operador inválido.'),
  body('rules.*.value').trim().notEmpty().withMessage('Valor da regra obrigatório.'),
  body('matchAll').optional().isBoolean(),
  validate,
  ctrl.saveSegment
);

router.get('/:id/preview', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.previewSegment);

router.delete('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.deleteSegment);

export default router;
