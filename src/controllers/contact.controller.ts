import type { NextFunction, Request, Response } from 'express';
import contactService from '../services/contact.service';
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
