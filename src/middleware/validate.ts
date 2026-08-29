import type { NextFunction, Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { ValidationError, type ValidationFieldError } from '../errors';
import { logWarn } from '../utils/logger';

export const validate = (req: Request, _res: Response, next: NextFunction): void => {
  const result = validationResult(req);
  if (result.isEmpty()) {
    next();
    return;
  }
  const errors: ValidationFieldError[] = result.array().map((e) => ({
    field: 'path' in e ? (e as { path: string }).path : undefined,
    message: e.msg as string,
  }));

  logWarn('validate.fail', `${req.method} ${req.originalUrl}`, {
    errors: errors.map((e) => ({ field: e.field, message: e.message })),
  });

  next(new ValidationError(errors));
};

/**
 * Opções padrão do `normalizeEmail` em TODA a API.
 *
 * `gmail_remove_dots` (default do express-validator) transforma `joao.silva@gmail.com`
 * em `joaosilva@gmail.com`. Como o contato é gravado com o endereço original, qualquer
 * rota que normalizasse com o default deixaria de casar com o registro no banco
 * (bounce que não acha o contato, teste enviado para outro endereço).
 * Use SEMPRE esta constante ao normalizar um email.
 */
export const EMAIL_NORMALIZE = { gmail_remove_dots: false } as const;
