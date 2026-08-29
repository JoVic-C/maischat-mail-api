import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { AppError, ValidationError } from '../errors';
import { logError, logSideEffect } from '../utils/logger';

interface MongoDuplicateError extends Error {
  code: number;
  keyValue?: Record<string, unknown>;
}

function isMongoDuplicateError(err: unknown): err is MongoDuplicateError {
  return err instanceof Error && (err as { code?: number }).code === 11000;
}

export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  if (err instanceof ValidationError) {
    res.status(err.statusCode).json({ error: err.message, errors: err.errors });
    return;
  }

  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: err.message };
    if (err.code) body.code = err.code;
    if (err.details !== undefined) body.details = err.details;
    res.status(err.statusCode).json(body);
    return;
  }

  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Imagem muito grande (máx. 5 MB).' : `Erro no upload: ${err.message}`;
    res.status(400).json({ error: msg });
    return;
  }

  if (isMongoDuplicateError(err)) {
    const field = err.keyValue ? Object.keys(err.keyValue)[0] : 'campo';
    res.status(409).json({ error: `Valor duplicado para ${field}.` });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({ error: 'Dados inválidos.', details: err.message });
    return;
  }

  const ctx = { method: req.method, path: req.originalUrl };
  if (err instanceof Error && err.message) {
    logError('errorHandler.unhandled', err, ctx);
    res.status(500).json({ error: 'Erro interno.' });
    return;
  }

  logSideEffect('errorHandler.unknown', err, { ...ctx });
  res.status(500).json({ error: 'Erro interno.' });
};
