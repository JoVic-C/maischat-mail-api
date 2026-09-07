import { Router } from 'express';
import { body, param, query } from 'express-validator';
import * as ctrl from '../controllers/campaign.controller';
import { EMAIL_NORMALIZE, validate } from '../middleware/validate';

const router = Router();

router.get('/', ctrl.getCampaigns);

router.get('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.getCampaign);

router.post(
  '/save',
  body('id').optional().isMongoId().withMessage('ID inválido.'),
  body('name').trim().isLength({ min: 2 }).withMessage('Nome deve ter ao menos 2 caracteres.'),
  body('templateId').isMongoId().withMessage('Template inválido.'),
  body('listIds').isArray({ min: 1 }).withMessage('Selecione ao menos uma lista.'),
  body('listIds.*').isMongoId().withMessage('ID de lista inválido.'),
  body('smtpId').optional({ nullable: true }).isMongoId().withMessage('SMTP inválido.'),
  body('segmentId').optional({ nullable: true }).isMongoId().withMessage('Segmento inválido.'),
  body('attachments').optional().isArray().withMessage('Anexos deve ser um array.'),
  body('attachments.*.filename').optional().isString(),
  body('attachments.*.storedName').optional().isString(),
  validate,
  ctrl.saveCampaign
);

router.get(
  '/:id/logs',
  param('id').isMongoId().withMessage('ID inválido.'),
  query('page').optional().isInt({ min: 1 }).withMessage('Página inválida.'),
  query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('Limite inválido.'),
  query('status')
    .optional()
    .isIn(['pending', 'sent', 'failed', 'bounced', 'opened', 'clicked', 'unsubscribed'])
    .withMessage('Status inválido.'),
  validate,
  ctrl.getCampaignLogs
);

// Download do relatório de envios. Rota separada da de logs porque devolve arquivo,
// não JSON paginado — e percorre a campanha inteira, sem teto de página.
router.get(
  '/:id/report',
  param('id').isMongoId().withMessage('ID inválido.'),
  query('status')
    .optional()
    .isIn(['pending', 'sent', 'failed', 'bounced', 'opened', 'clicked', 'unsubscribed'])
    .withMessage('Status inválido.'),
  query('format').optional().isIn(['xlsx', 'csv']).withMessage('Formato inválido.'),
  validate,
  ctrl.downloadCampaignReport
);

router.post(
  '/:id/start',
  param('id').isMongoId().withMessage('ID inválido.'),
  body('onlyDelivered').optional().isBoolean().withMessage('onlyDelivered deve ser booleano.'),
  validate,
  ctrl.startCampaign
);

router.post(
  '/:id/test-email',
  param('id').isMongoId().withMessage('ID inválido.'),
  body('email').isEmail().withMessage('Email inválido.').normalizeEmail(EMAIL_NORMALIZE),
  validate,
  ctrl.testEmailCampaign
);

router.post(
  '/:id/schedule',
  param('id').isMongoId().withMessage('ID inválido.'),
  body('scheduledAt').isISO8601().withMessage('Data de agendamento inválida.'),
  validate,
  ctrl.scheduleCampaign
);

router.post('/:id/unschedule', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.unscheduleCampaign);

router.post('/:id/pause', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.pauseCampaign);

router.post('/:id/resume', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.resumeCampaign);

router.delete('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.deleteCampaign);

export default router;
