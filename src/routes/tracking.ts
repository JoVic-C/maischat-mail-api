import { Router } from 'express';
import { param } from 'express-validator';
import * as ctrl from '../controllers/tracking.controller';
import { validate } from '../middleware/validate';

const router = Router();

const idRules = [param('c').isMongoId(), param('id').isMongoId(), validate];

// Públicas: chamadas pelo cliente de email do destinatário, sem autenticação.
router.get('/open/:c/:id', ...idRules, ctrl.trackOpen);
router.get('/click/:c/:id', ...idRules, ctrl.trackClick);
router.get('/unsubscribe/:c/:id', ...idRules, ctrl.unsubscribeConfirmPage);
router.post('/unsubscribe/:c/:id', ...idRules, ctrl.trackUnsubscribe);

export default router;
