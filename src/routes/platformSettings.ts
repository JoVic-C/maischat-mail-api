import { Router } from 'express';
import { body } from 'express-validator';
import * as ctrl from '../controllers/platformSettings.controller';
import { validate } from '../middleware/validate';
import { CONCURRENCY_MAX, CONCURRENCY_MIN, RATE_PER_MINUTE_MAX, RATE_PER_MINUTE_MIN } from '../models/PlatformSettings';

const router = Router();

// Ajustes da plataforma inteira: sem tenantContext.

router.get('/', ctrl.getPlatformSettings);

router.put(
  '/',
  body('workerConcurrency')
    .isInt({ min: CONCURRENCY_MIN, max: CONCURRENCY_MAX })
    .withMessage(`Concorrência deve estar entre ${CONCURRENCY_MIN} e ${CONCURRENCY_MAX}.`),
  body('ratePerMinute')
    .isInt({ min: RATE_PER_MINUTE_MIN, max: RATE_PER_MINUTE_MAX })
    .withMessage(`Taxa deve estar entre ${RATE_PER_MINUTE_MIN} e ${RATE_PER_MINUTE_MAX} emails por minuto.`),
  validate,
  ctrl.updatePlatformSettings
);

export default router;
