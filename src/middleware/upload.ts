import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from 'express';
import multer from 'multer';

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

/**
 * Planilha de importação de contatos (.csv ou .xlsx).
 *
 * Vai para IMPORT_DIR (fora de `uploads/`, que é servido estático e sem login — um
 * arquivo aqui é a base de contatos de um cliente) e é gravado em disco em streaming:
 * o arquivo nunca passa inteiro pela memória do processo.
 */
const IMPORT_MAX_MB = Number(process.env.IMPORT_MAX_MB || 100);

/**
 * Traduz uma falha ao preparar o diretório de destino.
 *
 * Sem isto a exceção do `mkdirSync` sobe crua e vira um "Erro interno." sem pista
 * nenhuma — que é o que se vê quando o volume de dados chega ao container com dono
 * diferente do usuário `node` do Dockerfile, ou quando o disco enche. As duas causas
 * são de infraestrutura, e a mensagem precisa dizer isso para não mandar o operador
 * procurar defeito no arquivo enviado.
 */
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
  // A extensão é PRESERVADA de propósito: é por ela que o worker decide entre o
  // leitor de CSV e o de planilha. Forçar `.csv` aqui faria um .xlsx ser lido como
  // texto e a importação encontrar zero linhas válidas.
  filename: (_req, file, cb) =>
    cb(null, `${crypto.randomBytes(12).toString('hex')}${sheetExtension(file.originalname) || '.csv'}`),
});

export const uploadImportFile = multer({
  storage: importStorage,
  limits: { fileSize: IMPORT_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // A decisão é pela EXTENSÃO, não pelo mimetype: o Windows anuncia .csv como
    // `application/vnd.ms-excel`, o mesmo do .xls — que não sabemos ler.
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

/**
 * Envolve um handler do multer para traduzir o estouro de tamanho.
 *
 * O limite só é conhecido aqui: cada upload tem o seu — imagem 5 MB, anexo 10 MB,
 * planilha IMPORT_MAX_MB. Quando o erro chega ao middleware genérico essa informação
 * já se perdeu, e a mensagem de lá dizia "máx. 5 MB" para os três casos.
 */
function comLimiteNaMensagem(handler: RequestHandler, limiteMb: number): RequestHandler {
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        next(new BadRequestError(`Arquivo maior que o limite de ${limiteMb} MB.`));
        return;
      }
      next(err);
    });
  };
}

/** Handlers prontos para as rotas, já com a mensagem de tamanho certa. */
export const handleImageUpload = comLimiteNaMensagem(uploadImage.single('image') as unknown as RequestHandler, 5);
export const handleDocUpload = comLimiteNaMensagem(uploadDoc.single('file') as unknown as RequestHandler, 10);
export const handleImportUpload = comLimiteNaMensagem(
  uploadImportFile.single('file') as unknown as RequestHandler,
  IMPORT_MAX_MB
);
