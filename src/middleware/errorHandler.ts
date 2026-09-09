import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { AppError, ValidationError } from '../errors';
import { logError, logSideEffect, logWarn } from '../utils/logger';

interface MongoDuplicateError extends Error {
  code: number;
  keyValue?: Record<string, unknown>;
}

function isMongoDuplicateError(err: unknown): err is MongoDuplicateError {
  return err instanceof Error && (err as { code?: number }).code === 11000;
}

/**
 * Id que não é um ObjectId.
 *
 * Vem por dois caminhos: `new Types.ObjectId(x)` direto, que lança BSONError, e o cast
 * automático do Mongoose numa query, que lança CastError. O nome é comparado como
 * texto para não depender do pacote `bson`, que é dependência transitiva.
 */
function isIdMalformado(err: unknown): boolean {
  if (err instanceof mongoose.Error.CastError) return err.kind === 'ObjectId';
  return err instanceof Error && err.name === 'BSONError';
}

/** Códigos do multer traduzidos para o que o usuário pode fazer a respeito. */
const MENSAGENS_UPLOAD: Record<string, string> = {
  LIMIT_FILE_SIZE: 'Arquivo muito grande.',
  LIMIT_FILE_COUNT: 'Arquivos demais de uma vez.',
  LIMIT_PART_COUNT: 'Arquivos demais de uma vez.',
  LIMIT_UNEXPECTED_FILE: 'Envie o arquivo pelo campo correto do formulário.',
  LIMIT_FIELD_KEY: 'Formulário inválido.',
  LIMIT_FIELD_VALUE: 'Um dos campos do formulário é grande demais.',
  LIMIT_FIELD_COUNT: 'Campos demais no formulário.',
};

/** Campos únicos do banco com nome que faça sentido para quem preencheu o formulário. */
const NOMES_DE_CAMPO: Record<string, string> = {
  email: 'e-mail',
  name: 'nome',
  slug: 'identificador',
  token: 'token',
};

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
    // A mensagem do multer é interna ("Unexpected field", "Too many files") e ia crua
    // para a tela. Cada código vira uma frase que diz o que fazer.
    logWarn('errorHandler.upload', err.code, { method: req.method, path: req.originalUrl });
    res.status(400).json({ error: MENSAGENS_UPLOAD[err.code] ?? 'Não foi possível enviar o arquivo.' });
    return;
  }

  if (isMongoDuplicateError(err)) {
    const campo = err.keyValue ? Object.keys(err.keyValue)[0] : '';
    const nome = NOMES_DE_CAMPO[campo];
    // Sem o nome amigável a resposta era "Valor duplicado para tenantId_1_email_1" —
    // o nome do índice do Mongo, que não diz nada a quem preencheu o formulário.
    logWarn('errorHandler.duplicado', campo || 'desconhecido');
    res.status(409).json({ error: nome ? `Já existe um registro com este ${nome}.` : 'Este registro já existe.' });
    return;
  }

  if (isIdMalformado(err)) {
    // Um id que não é ObjectId é erro de quem chamou, não falha do servidor. Sem este
    // ramo, `new Types.ObjectId('undefined')` — vindo de um campo que o painel não
    // preencheu — subia como exceção crua e virava 500 "Erro interno.", indistinguível
    // de um defeito nosso. São nove conversões assim espalhadas pelos serviços; tratar
    // aqui cobre todas de uma vez.
    logWarn('errorHandler.idMalformado', (err as Error).message, { method: req.method, path: req.originalUrl });
    res.status(400).json({ error: 'A requisição trouxe um identificador inválido.', code: 'ID_INVALIDO' });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    // O `details` levava a mensagem do Mongoose: inglês e caminhos do schema.
    logWarn('errorHandler.schema', err.message, { method: req.method, path: req.originalUrl });
    res.status(400).json({ error: 'Dados inválidos.' });
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
