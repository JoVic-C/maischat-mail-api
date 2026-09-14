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
 * Use sempre ao normalizar email. O padrão `gmail_remove_dots` transformaria
 * `joao.silva@gmail.com` em `joaosilva@gmail.com`, que não casa com o contato gravado.
 */
export const EMAIL_NORMALIZE = { gmail_remove_dots: false } as const;
