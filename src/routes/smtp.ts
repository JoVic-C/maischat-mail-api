import { Router } from 'express';
import { body, param } from 'express-validator';
import * as ctrl from '../controllers/smtp.controller';
import { EMAIL_NORMALIZE, validate } from '../middleware/validate';

const router = Router();

const credentialRules = [
  body('host').trim().notEmpty().withMessage('Host obrigatório.'),
  body('port').isInt({ min: 1, max: 65535 }).withMessage('Porta inválida.'),
  body('secure').optional().isBoolean(),
  body('user').trim().notEmpty().withMessage('Usuário obrigatório.'),
  body('password').isString().notEmpty().withMessage('Senha obrigatória.'),
];

router.get('/', ctrl.getSmtpServers);

// Credenciais obrigatórias só na criação: na edição dá para mudar nome e limites sem reenviar a senha.
const onCreate = body('id').not().exists();
router.post(
  '/save',
  body('id').optional().isMongoId().withMessage('ID inválido.'),
  body('name').trim().isLength({ min: 2 }).withMessage('Nome deve ter ao menos 2 caracteres.'),
  body('fromName').trim().notEmpty().withMessage('Nome do remetente obrigatório.'),
  body('fromEmail').isEmail().withMessage('Email do remetente inválido.').normalizeEmail(EMAIL_NORMALIZE),
  body('isDefault').optional().isBoolean(),
  body('dailyLimit').optional().isInt({ min: 0 }),
  body('hourlyLimit').optional().isInt({ min: 0 }),
  body('host').if(onCreate).trim().notEmpty().withMessage('Host obrigatório.'),
  body('port').if(onCreate).isInt({ min: 1, max: 65535 }).withMessage('Porta inválida.'),
  body('secure').optional().isBoolean(),
  body('user').if(onCreate).trim().notEmpty().withMessage('Usuário obrigatório.'),
  body('password').if(onCreate).isString().notEmpty().withMessage('Senha obrigatória.'),
  validate,
  ctrl.saveSmtp
);

router.post('/test', ...credentialRules, validate, ctrl.testConnection);

router.post(
  '/test-email',
  body('to').isEmail().withMessage('Destinatário inválido.').normalizeEmail(EMAIL_NORMALIZE),
  body('from').trim().notEmpty().withMessage('Remetente obrigatório.'),
  ...credentialRules,
  validate,
  ctrl.sendTestEmail
);

router.delete('/:id', param('id').isMongoId().withMessage('ID inválido.'), validate, ctrl.deleteSmtp);

export default router;
