import { Router } from 'express';
import { body, param, query } from 'express-validator';
import * as ctrl from '../controllers/list.controller';
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
