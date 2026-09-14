import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from 'express';
import multer from 'multer';

import { getTenantContext, runInContext } from '../config/tenantContext';
import { BadRequestError, InternalServerError } from '../errors';
import { ensureImportDir, IMPORT_DIR } from '../services/contactImport.service';
import { logSideEffect } from '../utils/logger';
import { isLegacyExcel, isSupportedSheet, sheetExtension } from '../utils/sheetStream';

const UPLOAD_DIR = 'uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const ALLOWED_DOC = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + (EXT[file.mimetype] || '')),
});

export const uploadImage = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (EXT[file.mimetype]) cb(null, true);
    else cb(new BadRequestError('Formato inválido. Use PNG, JPG, GIF ou WEBP.'));
  },
});

const docStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) =>
    cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname).toLowerCase()),
});

export const uploadDoc = multer({
  storage: docStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_DOC.has(file.mimetype)) cb(null, true);
    else cb(new BadRequestError('Tipo de arquivo não permitido para anexo.'));
  },
});

const IMPORT_MAX_MB = Number(process.env.IMPORT_MAX_MB || 100);

/** Falha de permissão ou disco é de infraestrutura; a mensagem não pode culpar o arquivo. */
function erroDeDestino(err: unknown, destino: string): Error {
  const codigo = (err as NodeJS.ErrnoException)?.code;
  logSideEffect('upload.destinoIndisponivel', err, { destino, codigo: codigo ?? 'desconhecido' });

  if (codigo === 'EACCES' || codigo === 'EPERM') {
    return new InternalServerError(
      'O servidor não tem permissão para gravar o arquivo. Avise o suporte.',
      'DESTINO_SEM_PERMISSAO'
    );
  }
  if (codigo === 'ENOSPC') {
    return new InternalServerError('Sem espaço em disco no servidor. Avise o suporte.', 'DISCO_CHEIO');
  }
  return new InternalServerError('Não foi possível preparar o envio do arquivo no servidor.', 'DESTINO_INDISPONIVEL');
}

const importStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureImportDir();
      cb(null, IMPORT_DIR);
    } catch (err) {
      cb(erroDeDestino(err, IMPORT_DIR), '');
    }
  },
  // A extensão é preservada: é por ela que o worker escolhe entre o leitor de CSV e o de planilha.
  filename: (_req, file, cb) =>
    cb(null, `${crypto.randomBytes(12).toString('hex')}${sheetExtension(file.originalname) || '.csv'}`),
});

export const uploadImportFile = multer({
  storage: importStorage,
  limits: { fileSize: IMPORT_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Pela extensão: o Windows anuncia .csv com o mesmo mimetype do .xls.
    if (isLegacyExcel(file.originalname)) {
      cb(new BadRequestError('Formato .xls (Excel 97-2003) não é suportado. Salve como .xlsx ou CSV.'));
      return;
    }
    if (isSupportedSheet(file.originalname)) {
      cb(null, true);
      return;
    }
    cb(new BadRequestError('Envie um arquivo .csv ou .xlsx.'));
  },
});

/** Envolve o multer para informar o limite de tamanho daquele upload. */
export function comLimiteNaMensagem(handler: RequestHandler, limiteMb: number): RequestHandler {
  return (req, res, next) => {
    // O callback do multer roda fora do contexto do cliente (ver runInContext); restaura aqui.
    const contexto = getTenantContext();

    handler(req, res, (err: unknown) => {
      runInContext(contexto, () => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          next(new BadRequestError(`Arquivo maior que o limite de ${limiteMb} MB.`));
          return;
        }
        next(err);
      });
    });
  };
}

export const handleImageUpload = comLimiteNaMensagem(uploadImage.single('image') as unknown as RequestHandler, 5);
export const handleDocUpload = comLimiteNaMensagem(uploadDoc.single('file') as unknown as RequestHandler, 10);
export const handleImportUpload = comLimiteNaMensagem(
  uploadImportFile.single('file') as unknown as RequestHandler,
  IMPORT_MAX_MB
);
