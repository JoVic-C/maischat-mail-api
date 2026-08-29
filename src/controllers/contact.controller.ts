import type { NextFunction, Request, Response } from 'express';
import contactService from '../services/contact.service';
import { buildInvalidExcel } from '../utils/excel';
import { logCtrlError } from '../utils/logger';

export const getContacts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { search, listId, status, delivery, page, limit } = req.query as Record<string, string | undefined>;
    const result = await contactService.list({
      search,
      listId,
      status: status as 'active' | 'unsubscribed' | 'bounced' | undefined,
      delivery: delivery as 'delivered' | 'never' | 'undeliverable' | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json(result);
  } catch (err) {
    logCtrlError('contact.getContacts', req, err);
    next(err);
  }
};

export const getContact = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const contact = await contactService.getById(req.params.id);
    res.json(contact);
  } catch (err) {
    logCtrlError('contact.getContact', req, err);
    next(err);
  }
};

export const createContact = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const contact = await contactService.create(req.body);
    res.status(201).json({ message: 'Contato criado', contact });
  } catch (err) {
    logCtrlError('contact.createContact', req, err);
    next(err);
  }
};

export const updateContact = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const contact = await contactService.update(req.params.id, req.body);
    res.json({ message: 'Contato atualizado.', contact });
  } catch (err) {
    logCtrlError('contact.updateContact', req, err);
    next(err);
  }
};

export const saveContact = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const contact = await contactService.save(req.body);
    res.json({ message: 'Contato salvo.', contact });
  } catch (err) {
    logCtrlError('contact.saveContact', req, err);
    next(err);
  }
};

export const reactivateContact = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const contact = await contactService.reactivate(req.params.id);
    res.json({ message: 'Contato reativado.', contact });
  } catch (err) {
    logCtrlError('contact.reactivateContact', req, err);
    next(err);
  }
};

export const deleteContact = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await contactService.remove(req.params.id);
    res.status(204).send();
  } catch (err) {
    logCtrlError('contact.deleteContact', req, err);
    next(err);
  }
};

export const bulkDeleteContacts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await contactService.bulkDelete(req.body.ids);
    res.json({ message: `${result.deleted} contato(s) excluído(s).`, ...result });
  } catch (err) {
    logCtrlError('contact.bulkDeleteContacts', req, err);
    next(err);
  }
};

export const importContacts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await contactService.importCsv(req.body.csv, req.body.listIds ?? []);
    res.json({
      message: `${result.imported} importado(s), ${result.invalid.length} incorreto(s).`,
      ...result,
    });
  } catch (err) {
    logCtrlError('contact.importContacts', req, err);
    next(err);
  }
};

export const exportInvalidContacts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const buffer = await buildInvalidExcel(req.body.rows ?? []);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="contatos-incorretos.xlsx"');
    res.send(buffer);
  } catch (err) {
    logCtrlError('contact.exportInvalidContacts', req, err);
    next(err);
  }
};

export const validateContactsStream = async (req: Request, res: Response): Promise<void> => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // impede buffering em proxies (nginx)
  res.flushHeaders?.();

  const send = (e: unknown): boolean => res.write(`data: ${JSON.stringify(e)}\n\n`);

  try {
    await contactService.validateCsvStream(req.body.csv, req.body.listIds ?? [], send);
  } catch (err) {
    logCtrlError('contact.validateContactsStream', req, err);
    // headers já foram enviados (200), então reportamos o erro pelo próprio stream
    send({ type: 'error', message: err instanceof Error ? err.message : 'Erro ao validar.' });
  } finally {
    res.end();
  }
};

export const importValidatedContacts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await contactService.importValidated(req.body.rows ?? [], req.body.listIds ?? []);
    res.json({ message: `${result.imported} importado(s).`, ...result });
  } catch (err) {
    logCtrlError('contact.importValidatedContacts', req, err);
    next(err);
  }
};
