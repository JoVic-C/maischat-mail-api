import { Router } from 'express';
import { query } from 'express-validator';
import * as ctrl from '../controllers/platformMonitor.controller';
import { validate } from '../middleware/validate';

const router = Router();

// Leituras que atravessam clientes de propósito: sem tenantContext.

router.get(
  '/overview',
  query('hours').optional().isInt({ min: 1, max: 168 }).withMessage('Janela deve ser entre 1 e 168 horas.'),
  validate,
  ctrl.getOverview
);

router.get(
  '/failures',
  query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('Limite deve ser entre 1 e 200.'),
  validate,
  ctrl.getFailures
);

export default router;
