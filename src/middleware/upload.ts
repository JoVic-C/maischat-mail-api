import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

import { BadRequestError } from '../errors';
import { ensureImportDir, IMPORT_DIR } from '../services/contactImport.service';
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

const importStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureImportDir();
    cb(null, IMPORT_DIR);
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
