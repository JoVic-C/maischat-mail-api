import { Router } from 'express';
import { query } from 'express-validator';
import * as ctrl from '../controllers/platformMonitor.controller';
import { validate } from '../middleware/validate';

const router = Router();

// Administração da plataforma — o server.ts já exige requireSuperadmin.
// NÃO passa pelo tenantContext: estas leituras atravessam clientes de propósito.

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
