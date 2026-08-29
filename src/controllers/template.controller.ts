import type { NextFunction, Request, Response } from 'express';
import templateService from '../services/template.service';
import { logCtrlError } from '../utils/logger';

export const getTemplates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { search } = req.query as { search?: string };
    const templates = await templateService.list(search);
    res.json(templates);
  } catch (err) {
    logCtrlError('template.getTemplates', req, err);
    next(err);
  }
};

export const getTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const template = await templateService.getById(req.params.id);
    res.json(template);
  } catch (err) {
    logCtrlError('template.getTemplate', req, err);
    next(err);
  }
};

export const saveTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const template = await templateService.save(req.body);
    res.json({ message: 'Template salvo.', template });
  } catch (err) {
    logCtrlError('template.saveTemplate', req, err);
    next(err);
  }
};

export const previewTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await templateService.preview(req.body);
    res.json(result);
  } catch (err) {
    logCtrlError('template.previewTemplate', req, err);
    next(err);
  }
};

export const duplicateTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const template = await templateService.duplicate(req.params.id);
    res.status(201).json({ message: 'Template duplicado.', template });
  } catch (err) {
    logCtrlError('template.duplicateTemplate', req, err);
    next(err);
  }
};

export const deleteTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await templateService.remove(req.params.id);
    res.status(204).send();
  } catch (err) {
    logCtrlError('template.deleteTemplate', req, err);
    next(err);
  }
};
