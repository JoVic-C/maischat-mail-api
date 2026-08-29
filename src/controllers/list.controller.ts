import type { NextFunction, Request, Response } from 'express';
import listService from '../services/list.service';
import { logCtrlError } from '../utils/logger';

export const getLists = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { search, type } = req.query as { search?: string; type?: 'public' | 'private' };
    const lists = await listService.list(search, type);
    res.json(lists);
  } catch (err) {
    logCtrlError('list.getLists', req, err);
    next(err);
  }
};
export const getList = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const list = await listService.getById(req.params.id);
    res.json(list);
  } catch (err) {
    logCtrlError('list.getList', req, err);
    next(err);
  }
};

export const saveList = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const list = await listService.save(req.body);
    res.json({ message: 'Lista salva.', list });
  } catch (err) {
    logCtrlError('list.saveList', req, err);
    next(err);
  }
};

export const createList = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const list = await listService.create(req.body);
    res.status(201).json({ message: 'Lista criada', list });
  } catch (err) {
    logCtrlError('list.createList', req, err);
    next(err);
  }
};

export const updateList = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const list = await listService.update(req.params.id, req.body);
    res.json({ message: 'Lista atualizada', list });
  } catch (err) {
    logCtrlError('list.updateList', req, err);
    next(err);
  }
};

export const deleteList = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await listService.remove(req.params.id);
    res.status(204).send();
  } catch (err) {
    logCtrlError('list.deleteList', req, err);
    next(err);
  }
};

export const resyncListCounts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await listService.resyncCounts();
    res.json({ message: `${result.updated} de ${result.total} lista(s) recalculada(s).`, ...result });
  } catch (err) {
    logCtrlError('list.resyncListCounts', req, err);
    next(err);
  }
};
