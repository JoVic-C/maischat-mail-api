import { Router } from 'express';
import { body, param, query } from 'express-validator';
import * as ctrl from '../controllers/contact.controller';
import { EMAIL_NORMALIZE, validate } from '../middleware/validate';

const router = Router();

const contactBodyRules = [
  body('name').optional().trim(),
  body('phone').optional().trim(),
  body('company').optional().trim(),
  body('lists').optional().isArray().withMessage('Listas deve ser um array.'),
  body('lists.*').isMongoId().withMessage('ID de lista inválido.'),
  body('status').optional().isIn(['active', 'unsubscribed', 'bounced']).withMessage('Status inválido.'),
  body('metadata').optional().isObject().withMessage('Metadata deve ser um objeto.'),
];

router.get(
  '/',
  query('search').optional().trim(),
  query('listId').optional().isMongoId().withMessage('ID de lista inválido.'),
  query('status').optional().isIn(['active', 'unsubscribed', 'bounced']).withMessage('Status inválido.'),
  query('delivery').optional().isIn(['delivered', 'never', 'undeliverable']).withMessage('Filtro de entrega inválido.'),
  query('page').optional().isInt({ min: 1 }).withMessage('Página inválida.'),
  query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('Limite inválido.'),
  validate,
  ctrl.getContacts
);

router.get('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.getContact);

router.post(
  '/',
  body('email').isEmail().withMessage('Email inválido.').normalizeEmail(EMAIL_NORMALIZE),
  ...contactBodyRules,
  validate,
  ctrl.createContact
);

router.put(
  '/:id',
  param('id').isMongoId().withMessage('ID inválido.'),
  body('email').optional().isEmail().withMessage('Email inválido.').normalizeEmail(EMAIL_NORMALIZE),
  ...contactBodyRules,
  validate,
  ctrl.updateContact
);

router.post(
  '/save',
  body('id').optional().isMongoId().withMessage('ID inválido.'),
  body('email').isEmail().withMessage('Email inválido.').normalizeEmail(EMAIL_NORMALIZE),
  ...contactBodyRules,
  validate,
  ctrl.saveContact
);

router.post(
  '/bulk-delete',
  body('ids').isArray({ min: 1 }).withMessage('Envie ao menos um ID.'),
  body('ids.*').isMongoId().withMessage('ID inválido.'),
  validate,
  ctrl.bulkDeleteContacts
);

router.post('/:id/reactivate', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.reactivateContact);

router.delete('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.deleteContact);

router.post(
  '/import',
  body('csv').isString().notEmpty().withMessage('Conteúdo CSV obrigatório.'),
  body('listIds').optional().isArray().withMessage('listIds deve ser um array.'),
  body('listIds.*').isMongoId().withMessage('ID de lista inválido.'),
  validate,
  ctrl.importContacts
);

router.post(
  '/invalid-export',
  body('rows').isArray().withMessage('Envie as linhas inválidas.'),
  validate,
  ctrl.exportInvalidContacts
);

router.post(
  '/validate-stream',
  body('csv').isString().notEmpty().withMessage('Conteúdo CSV obrigatório.'),
  body('listIds').optional().isArray().withMessage('listIds deve ser um array.'),
  body('listIds.*').isMongoId().withMessage('ID de lista inválido.'),
  validate,
  ctrl.validateContactsStream
);

router.post(
  '/import-validated',
  body('rows').isArray({ min: 1 }).withMessage('Envie as linhas validadas.'),
  body('listIds').optional().isArray().withMessage('listIds deve ser um array.'),
  body('listIds.*').isMongoId().withMessage('ID de lista inválido.'),
  validate,
  ctrl.importValidatedContacts
);

export default router;
