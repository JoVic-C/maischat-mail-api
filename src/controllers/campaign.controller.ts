import type { NextFunction, Request, Response } from 'express';
import campaignService from '../services/campaign.service';
import campaignReportService from '../services/campaignReport.service';
import { logCtrlError } from '../utils/logger';

export const getCampaigns = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const campaigns = await campaignService.list();
    res.json(campaigns);
  } catch (err) {
    logCtrlError('campaign.getCampaigns', req, err);
    next(err);
  }
};

export const getCampaign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const campaign = await campaignService.getById(req.params.id);
    res.json(campaign);
  } catch (err) {
    logCtrlError('campaign.getCampaign', req, err);
    next(err);
  }
};

export const saveCampaign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const campaign = await campaignService.save(req.body);
    res.json({ message: 'Campanha salva.', campaign });
  } catch (err) {
    logCtrlError('campaign.saveCampaign', req, err);
    next(err);
  }
};

export const deleteCampaign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await campaignService.remove(req.params.id);
    res.status(204).send();
  } catch (err) {
    logCtrlError('campaign.deleteCampaign', req, err);
    next(err);
  }
};

export const startCampaign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await campaignService.start(req.params.id, { onlyDelivered: req.body.onlyDelivered === true });
    res.json({ message: `${result.queued} email(s) enfileirado(s).`, ...result });
  } catch (err) {
    logCtrlError('campaign.startCampaign', req, err);
    next(err);
  }
};

export const pauseCampaign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await campaignService.pause(req.params.id);
    res.json({ message: 'Campanha pausada.' });
  } catch (err) {
    logCtrlError('campaign.pauseCampaign', req, err);
    next(err);
  }
};

export const resumeCampaign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await campaignService.resume(req.params.id);
    res.json({ message: 'Campanha retomada.' });
  } catch (err) {
    logCtrlError('campaign.resumeCampaign', req, err);
    next(err);
  }
};

export const getCampaignLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page, limit, status } = req.query as Record<string, string | undefined>;
    const result = await campaignService.getLogs(req.params.id, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      status,
    });
    // O corpo continua sendo o array que o painel consome; a paginação vai nos headers.
    res.set('X-Total-Count', String(result.total));
    res.set('X-Page', String(result.page));
    res.set('X-Page-Size', String(result.limit));
    res.set('Access-Control-Expose-Headers', 'X-Total-Count, X-Page, X-Page-Size');
    res.json(result.logs);
  } catch (err) {
    logCtrlError('campaign.getCampaignLogs', req, err);
    next(err);
  }
};

export const testEmailCampaign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await campaignService.sendTest(req.params.id, req.body.email);
    res.json({ message: `Email de teste enviado para ${result.to}.`, ...result });
  } catch (err) {
    logCtrlError('campaign.testEmailCampaign', req, err);
    next(err);
  }
};

export const scheduleCampaign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await campaignService.schedule(req.params.id, new Date(req.body.scheduledAt));
    res.json({ message: 'Campanha agendada.', ...result });
  } catch (err) {
    logCtrlError('campaign.scheduleCampaign', req, err);
    next(err);
  }
};

export const unscheduleCampaign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await campaignService.unschedule(req.params.id);
    res.json({ message: 'Agendamento cancelado.' });
  } catch (err) {
    logCtrlError('campaign.unscheduleCampaign', req, err);
    next(err);
  }
};

/**
 * O corpo sai em streaming: depois do primeiro byte os headers já foram enviados, e a
 * única saída para um erro é encerrar a conexão.
 */
export const downloadCampaignReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status, format } = req.query as Record<string, string | undefined>;
    await campaignReportService.stream(req.params.id, res, {
      status: status as never,
      formato: format as never,
    });
  } catch (err) {
    logCtrlError('campaign.downloadCampaignReport', req, err);
    if (res.headersSent) {
      res.end();
      return;
    }
    next(err);
  }
};
