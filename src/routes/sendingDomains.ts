import { Router } from 'express';
import { param } from 'express-validator';
import * as ctrl from '../controllers/sendingDomain.controller';
import { validate } from '../middleware/validate';

const router = Router();

router.get('/', ctrl.getSendingDomains);

router.post(
  '/:domain/verify',
  param('domain')
    .trim()
    .toLowerCase()
    .matches(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
    .withMessage('Domínio inválido.'),
  validate,
  ctrl.verifySendingDomain
);

export default router;
