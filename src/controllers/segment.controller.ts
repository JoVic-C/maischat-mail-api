import type { NextFunction, Request, Response } from 'express';
import segmentService from '../services/segment.service';
import { logCtrlError } from '../utils/logger';

export const getSegments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const segments = await segmentService.list();
    res.json(segments);
  } catch (err) {
    logCtrlError('segment.getSegments', req, err);
    next(err);
  }
};

export const saveSegment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const segment = await segmentService.save(req.body);
    res.json({ message: 'Segmento salvo', segment });
  } catch (err) {
    logCtrlError('segment.saveSegment', req, err);
    next(err);
  }
};

export const previewSegment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await segmentService.preview(req.params.id);
    res.json(result);
  } catch (err) {
    logCtrlError('segment.previewSegment', req, err);
    next(err);
  }
};

export const deleteSegment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await segmentService.remove(req.params.id);
    res.status(204).send();
  } catch (err) {
    logCtrlError('segment.deleteSegment', req, err);
    next(err);
  }
};
