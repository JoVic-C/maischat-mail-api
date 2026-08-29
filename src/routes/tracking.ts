import { Router } from 'express';
import { param } from 'express-validator';
import * as ctrl from '../controllers/tracking.controller';
import { validate } from '../middleware/validate';

const router = Router();

// :c (campanha) e :id (envio) devem ser ObjectIds — rejeita lixo antes de tocar no banco (defesa em profundidade).
const idRules = [param('c').isMongoId(), param('id').isMongoId(), validate];

// Rotas públicas — batem direto do cliente de email, sem auth.
router.get('/open/:c/:id', ...idRules, ctrl.trackOpen);
router.get('/click/:c/:id', ...idRules, ctrl.trackClick);
router.get('/unsubscribe/:c/:id', ...idRules, ctrl.unsubscribeConfirmPage); // página de confirmação (não descadastra)
router.post('/unsubscribe/:c/:id', ...idRules, ctrl.trackUnsubscribe); // efetiva (botão da página ou one-click RFC 8058)

export default router;
