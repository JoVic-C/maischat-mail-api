/**
 * Relatório de envios de uma campanha, escrito na resposta a partir de um cursor. Sai em
 * .xlsx e cai para CSV quando passa do teto de linhas de uma planilha.
 */
import type { Response } from 'express';
import { NotFoundError } from '../errors';
import Campaign from '../models/Campaign';
import SendLog, { type ISendLog, type SendStatus } from '../models/SendLog';
import { csvDate, csvRow, safeFileName, startCsvDownload, writeCsvLine } from '../utils/csvResponse';
import { type ColunaXlsx, deveUsarCsv, startXlsxDownload } from '../utils/xlsxResponse';

const COLUNAS: ColunaXlsx[] = [
  { titulo: 'Email', largura: 34 },
  { titulo: 'Situação', largura: 16 },
  { titulo: 'Enviado em', largura: 18, data: true },
  { titulo: 'Aberturas', largura: 11 },
  { titulo: 'Primeira abertura', largura: 18, data: true },
  { titulo: 'Cliques', largura: 10 },
  { titulo: 'Primeiro clique', largura: 18, data: true },
  { titulo: 'Erro', largura: 44 },
];

const TITULOS = COLUNAS.map((c) => c.titulo);

const SITUACAO: Record<SendStatus, string> = {
  pending: 'Na fila',
  sent: 'Entregue',
  failed: 'Falhou',
  bounced: 'Bounce',
  opened: 'Aberto',
  clicked: 'Clicado',
  unsubscribed: 'Descadastrado',
};

export type FormatoRelatorio = 'xlsx' | 'csv';

export interface ReportFilters {
  status?: SendStatus;
  formato?: FormatoRelatorio;
}

/** No xlsx as datas vão como Date, para o Excel ordenar e filtrar; no CSV, como texto. */
function valores(log: ISendLog, comoTexto: boolean): unknown[] {
  const data = (v: Date | null) => (comoTexto ? csvDate(v) : (v ?? ''));
  return [
    log.email,
    SITUACAO[log.status] ?? log.status,
    data(log.sentAt),
    log.openCount,
    data(log.openedAt),
    log.clickCount,
    data(log.clickedAt),
    log.error,
  ];
}

export class CampaignReportService {
  async stream(
    campaignId: string,
    res: Response,
    filtros: ReportFilters = {}
  ): Promise<{ linhas: number; formato: FormatoRelatorio }> {
    const campanha = await Campaign.findById(campaignId).select('name').lean();
    if (!campanha) throw new NotFoundError('Campanha não encontrada.');

    const filtro: Record<string, unknown> = { campaignId };
    if (filtros.status) filtro.status = filtros.status;

    // A contagem decide o formato, para não entregar um .xlsx que o Excel não abre.
    const total = await SendLog.countDocuments(filtro);
    const formato: FormatoRelatorio = filtros.formato === 'csv' || deveUsarCsv(total) ? 'csv' : 'xlsx';

    const resultado =
      formato === 'csv'
        ? await this.escreverCsv(res, campanha.name, filtro)
        : await this.escreverXlsx(res, campanha.name, filtro);

    return { ...resultado, formato };
  }

  private async escreverXlsx(
    res: Response,
    nomeCampanha: string,
    filtro: Record<string, unknown>
  ): Promise<{ linhas: number }> {
    const escritor = startXlsxDownload(res, safeFileName('envios', nomeCampanha, 'xlsx'), COLUNAS, 'Envios');

    let linhas = 0;
    const cursor = SendLog.find(filtro).sort({ createdAt: -1 }).lean<ISendLog>().cursor();
    try {
      for await (const log of cursor) {
        linhas++;
        escritor.addRow(valores(log, false));
      }
    } finally {
      await cursor.close();
    }

    await escritor.finish();
    return { linhas };
  }

  private async escreverCsv(
    res: Response,
    nomeCampanha: string,
    filtro: Record<string, unknown>
  ): Promise<{ linhas: number }> {
    startCsvDownload(res, safeFileName('envios', nomeCampanha), TITULOS);

    let linhas = 0;
    const cursor = SendLog.find(filtro).sort({ createdAt: -1 }).lean<ISendLog>().cursor();
    try {
      for await (const log of cursor) {
        linhas++;
        await writeCsvLine(res, csvRow(valores(log, true)));
      }
    } finally {
      await cursor.close();
    }

    res.end();
    return { linhas };
  }
}

export default new CampaignReportService();
