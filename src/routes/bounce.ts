import { Router } from 'express';
import { body } from 'express-validator';
import * as ctrl from '../controllers/bounce.controller';
import { EMAIL_NORMALIZE, validate } from '../middleware/validate';

const router = Router();

router.post(
  '/',
  body('email').isEmail().withMessage('Email inválido.').normalizeEmail(EMAIL_NORMALIZE),
  body('campaignId').optional().isMongoId().withMessage('ID de campanha inválido.'),
  validate,
  ctrl.reportBounce
);

export default router;
