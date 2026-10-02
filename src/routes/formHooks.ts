import cors from 'cors';
import express, { type RequestHandler, Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/formWebhook.controller';
import { formWebhookLimiter } from '../middleware/rateLimit';

const BODY_LIMIT = '100kb';

/** Arquivos ficam de fora: só os campos de texto seguem. */
const multipartFields = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 200, fieldSize: 10_000, parts: 300 },
  fileFilter: (_req, _file, cb) => cb(null, false),
}).any();

const textAsJson: RequestHandler = (req, _res, next) => {
  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      req.body = {};
    }
  }
  next();
};

const router = Router();

// Pública e chamada de qualquer site: sem credenciais, qualquer origem.
router.use(cors({ origin: true, credentials: false, methods: ['GET', 'POST', 'OPTIONS'] }));

router.get('/:token', ctrl.probeFormWebhook);

router.post(
  '/:token',
  formWebhookLimiter,
  express.json({ limit: BODY_LIMIT }),
  express.urlencoded({ extended: true, limit: BODY_LIMIT, parameterLimit: 300 }),
  express.text({ type: 'text/plain', limit: BODY_LIMIT }),
  textAsJson,
  multipartFields,
  ctrl.receiveFormSubmission
);

export default router;
