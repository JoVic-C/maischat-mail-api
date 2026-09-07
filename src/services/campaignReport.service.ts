/**
 * Relatório de envios de uma campanha, para download.
 *
 * Sai em .xlsx por padrão e é escrito direto na resposta, linha a linha, a partir de um
 * cursor do Mongo. Uma campanha grande tem um registro de envio POR DESTINATÁRIO —
 * juntar tudo num array antes de responder colocaria a lista inteira em memória, que é
 * o mesmo erro que a importação já teve. Aqui nada além da linha corrente existe.
 *
 * O CSV continua disponível e é imposto automaticamente quando a campanha passa do teto
 * de linhas de uma planilha (ver `deveUsarCsv`).
 */
import type { Response } from 'express';
import { NotFoundError } from '../errors';
import Campaign from '../models/Campaign';
import SendLog, { type ISendLog, type SendStatus } from '../models/SendLog';
import { csvDate, csvRow, safeFileName, startCsvDownload, writeCsvLine } from '../utils/csvResponse';
import { type ColunaXlsx, deveUsarCsv, startXlsxDownload } from '../utils/xlsxResponse';

/** Colunas do relatório, na ordem. As larguras evitam abrir o arquivo e redimensionar tudo. */
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

/** Rótulos em português — o arquivo é lido por gente, não por máquina. */
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
  /** Quando ausente, o relatório traz todos os envios da campanha. */
  status?: SendStatus;
  /** Padrão: xlsx. O CSV é imposto quando a campanha não cabe numa planilha. */
  formato?: FormatoRelatorio;
}

/**
 * Valores da linha, na ordem das colunas.
 *
 * No xlsx as datas vão como Date de verdade — é o que deixa o Excel ordenar e filtrar
 * por período. No CSV viram texto, porque lá tudo é texto de qualquer forma.
 */
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
  /**
   * Escreve o relatório na resposta enquanto lê do banco.
   *
   * Recebe o `res` de propósito, em vez de devolver um buffer: é o que mantém o pico
   * de memória constante, independente do tamanho da campanha.
   */
  async stream(
    campaignId: string,
    res: Response,
    filtros: ReportFilters = {}
  ): Promise<{ linhas: number; formato: FormatoRelatorio }> {
    // A busca é escopada pelo cliente da requisição (plugin tenantScope): pedir o
    // relatório de uma campanha de outro cliente simplesmente não encontra nada.
    const campanha = await Campaign.findById(campaignId).select('name').lean();
    if (!campanha) throw new NotFoundError('Campanha não encontrada.');

    const filtro: Record<string, unknown> = { campaignId };
    if (filtros.status) filtro.status = filtros.status;

    // A contagem decide o formato. É uma consulta a mais, indexada por campanha, e
    // evita entregar um .xlsx que o Excel se recusaria a abrir por excesso de linhas.
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
