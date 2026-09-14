import type { NextFunction, Request, Response } from 'express';
import { requireTenantId } from '../config/tenantContext';
import { BadRequestError } from '../errors';
import { enqueueImport, enqueueValidation } from '../queue/import.queue';
import contactImportService, { safeUnlink } from '../services/contactImport.service';
import { logCtrlError } from '../utils/logger';

/**
 * Cliente em que o job deve rodar. Vem do contexto e não do usuário: o superadmin opera
 * outro cliente pelo header X-Tenant-Id.
 */
function tenantOf(_req: Request): string {
  const tenantId = requireTenantId();
  if (!tenantId) throw new BadRequestError('Rota de importação exige contexto de cliente.');
  return String(tenantId);
}

/** Só recebe o arquivo e enfileira; a validação fica com o worker. */
export const startImport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new BadRequestError('Envie o arquivo CSV no campo "file".');

    // Campo de formulário multipart: chega como string.
    const raw = req.body.listIds;
    const listIds: string[] = Array.isArray(raw) ? raw : raw ? String(raw).split(',').filter(Boolean) : [];

    const job = await contactImportService.create({
      filePath: req.file.path,
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
      listIds,
      userId: String(req.user?.id),
    });

    await enqueueValidation(tenantOf(req), job.id);
    res.status(202).json({ message: 'Arquivo recebido. Validando...', id: job.id, status: job.status });
  } catch (err) {
    // Sem job, a limpeza periódica nunca acharia o arquivo que o multer já gravou.
    if (req.file) safeUnlink(req.file.path);
    logCtrlError('contactImport.startImport', req, err);
    next(err);
  }
};

export const getImportStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await contactImportService.getStatus(req.params.id));
  } catch (err) {
    logCtrlError('contactImport.getImportStatus', req, err);
    next(err);
  }
};

export const listOpenImports = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.json(await contactImportService.listOpen());
  } catch (err) {
    logCtrlError('contactImport.listOpenImports', req, err);
    next(err);
  }
};

export const confirmImport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const job = await contactImportService.confirm(req.params.id, req.body.listIds ?? []);
    await enqueueImport(tenantOf(req), job.id);
    res.status(202).json({ message: 'Importação iniciada.', id: job.id, status: job.status });
  } catch (err) {
    logCtrlError('contactImport.confirmImport', req, err);
    next(err);
  }
};

export const cancelImport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await contactImportService.cancel(req.params.id);
    res.json({ message: 'Importação cancelada.' });
  } catch (err) {
    logCtrlError('contactImport.cancelImport', req, err);
    next(err);
  }
};

export const downloadInvalid = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { format, buffer } = await contactImportService.buildInvalidReport(req.params.id);
    const isXlsx = format === 'xlsx';

    res.setHeader(
      'Content-Type',
      isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8'
    );
    res.setHeader('Content-Disposition', `attachment; filename="contatos-incorretos.${isXlsx ? 'xlsx' : 'csv'}"`);
    res.send(buffer);
  } catch (err) {
    logCtrlError('contactImport.downloadInvalid', req, err);
    next(err);
  }
};
