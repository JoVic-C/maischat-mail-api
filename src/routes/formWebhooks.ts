import { Router } from 'express';
import { body, param } from 'express-validator';
import * as ctrl from '../controllers/formWebhook.controller';
import { validate } from '../middleware/validate';

const router = Router();

const idParam = param('id').isMongoId().withMessage('ID inválido.');

router.get('/', ctrl.listFormWebhooks);

router.post(
  '/save',
  body('id').optional().isMongoId().withMessage('ID inválido.'),
  body('name').isString().trim().isLength({ min: 2, max: 80 }).withMessage('Nome deve ter entre 2 e 80 caracteres.'),
  body('templateId').isMongoId().withMessage('Escolha o template do email.'),
  body('smtpId').optional({ nullable: true }).isMongoId().withMessage('Servidor SMTP inválido.'),
  body('emailField').optional().isString().trim().isLength({ max: 100 }).withMessage('Campo do email muito longo.'),
  body('nameField').optional().isString().trim().isLength({ max: 100 }).withMessage('Campo do nome muito longo.'),
  body('hourlyLimit')
    .optional()
    .isInt({ min: 1, max: 5000 })
    .withMessage('Limite por hora deve estar entre 1 e 5000.')
    .toInt(),
  body('redirectUrl')
    .optional({ checkFalsy: true })
    .isURL({ protocols: ['http', 'https'], require_protocol: true })
    .withMessage('Página de obrigado inválida: use um endereço completo, com https://.')
    .isLength({ max: 500 }),
  body('isActive').optional().isBoolean().toBoolean(),
  validate,
  ctrl.saveFormWebhook
);

router.post('/:id/regenerate', idParam, validate, ctrl.regenerateFormWebhook);
router.get('/:id/submissions', idParam, validate, ctrl.getFormSubmissions);
router.delete('/:id', idParam, validate, ctrl.deleteFormWebhook);

export default router;
