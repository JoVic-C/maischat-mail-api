import { Router } from 'express';
import { query } from 'express-validator';
import * as ctrl from '../controllers/dashboard.controller';
import { validate } from '../middleware/validate';

const router = Router();

router.get('/stats', ctrl.getStats);

// Sem parâmetros: últimos 30 dias, agrupados por dia.
router.get(
  '/sends',
  query('de').optional().isISO8601().withMessage('Data inicial inválida.'),
  query('ate').optional().isISO8601().withMessage('Data final inválida.'),
  query('agrupamento').optional().isIn(['day', 'week', 'month']).withMessage('Agrupamento inválido.'),
  validate,
  ctrl.getSendReport
);

export default router;
