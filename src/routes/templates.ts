import { Router } from 'express';
import { body, param, query } from 'express-validator';
import * as ctrl from '../controllers/template.controller';
import { validate } from '../middleware/validate';

const router = Router();

router.get('/', query('search').optional().trim(), validate, ctrl.getTemplates);

router.get('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.getTemplate);

router.post(
  '/save',
  body('id').optional().isMongoId().withMessage('ID inválido.'),
  body('name').trim().isLength({ min: 2 }).withMessage('Nome deve ter ao menos 2 caracteres.'),
  body('subject').trim().notEmpty().withMessage('Assunto obrigatório.'),
  body('html').isString().notEmpty().withMessage('Conteúdo HTML obrigatório.'),
  validate,
  ctrl.saveTemplate
);

router.post(
  '/preview',
  body('html').isString().notEmpty().withMessage('Conteúdo HTML obrigatório.'),
  body('subject').optional().isString(),
  body('data').optional().isObject().withMessage('Dados de exemplo devem ser um objeto.'),
  validate,
  ctrl.previewTemplate
);

router.post('/:id/duplicate', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.duplicateTemplate);

router.delete('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.deleteTemplate);

export default router;
