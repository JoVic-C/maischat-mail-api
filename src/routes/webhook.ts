import { Router } from 'express';
import * as ctrl from '../controllers/webhook.controller';

const router = Router();

// Webhook público do xMailer (autenticado por Bearer token dentro do controller).
router.post('/xmailer', ctrl.xmailerWebhook);

export default router;
