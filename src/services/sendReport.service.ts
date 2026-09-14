/**
 * Relatório de envios da conta, por período. Agrega o SendLog, e não `Campaign.stats`,
 * porque só o log tem a data de cada envio.
 */

import { BadRequestError } from '../errors';
import SendLog from '../models/SendLog';

export type Agrupamento = 'day' | 'week' | 'month';

/** Sem fuso o Mongo corta os dias em UTC e um envio das 21h cai no dia seguinte. */
const FUSO = 'America/Sao_Paulo';

/** Evita séries enormes (anos agrupados por dia), ilegíveis e caras de montar. */
const MAX_PONTOS = 400;

const DIAS_PADRAO = 30;

export interface TotaisEnvio {
  /** Inclui os envios que ainda não saíram. */
  registros: number;
  enviados: number;
  abertos: number;
  clicados: number;
  falhas: number;
  bounces: number;
  descadastros: number;
}

export interface PontoEnvio extends TotaisEnvio {
  inicio: string;
}

export interface RelatorioEnvios {
  de: string;
  ate: string;
  agrupamento: Agrupamento;
  totais: TotaisEnvio;
  /** Percentuais sobre os enviados. */
  taxas: { abertura: number; clique: number; falha: number };
  serie: PontoEnvio[];
}

export interface FiltroRelatorio {
  de?: string;
  ate?: string;
  agrupamento?: Agrupamento;
}

const DIAS_POR_BALDE: Record<Agrupamento, number> = { day: 1, week: 7, month: 28 };

function zerado(): TotaisEnvio {
  return { registros: 0, enviados: 0, abertos: 0, clicados: 0, falhas: 0, bounces: 0, descadastros: 0 };
}

function parseData(valor: string | undefined, padrao: Date, rotulo: string): Date {
  if (!valor) return padrao;
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) throw new BadRequestError(`${rotulo} inválida.`);
  return data;
}

export class SendReportService {
  /** Depende do índice {tenantId, createdAt} do SendLog. */
  async gerar(filtro: FiltroRelatorio = {}): Promise<RelatorioEnvios> {
    const agrupamento = filtro.agrupamento ?? 'day';
    if (!['day', 'week', 'month'].includes(agrupamento)) {
      throw new BadRequestError('Agrupamento inválido. Use day, week ou month.');
    }

    const agora = new Date();
    const ate = parseData(filtro.ate, agora, 'Data final');
    const de = parseData(filtro.de, new Date(agora.getTime() - DIAS_PADRAO * 86_400_000), 'Data inicial');

    if (de > ate) throw new BadRequestError('A data inicial não pode ser maior que a final.');

    const dias = Math.ceil((ate.getTime() - de.getTime()) / 86_400_000) + 1;
    const pontosPrevistos = Math.ceil(dias / DIAS_POR_BALDE[agrupamento]);
    if (pontosPrevistos > MAX_PONTOS) {
      throw new BadRequestError(
        `Período longo demais para agrupar por ${agrupamento}. Escolha um intervalo menor ou agrupe por semana/mês.`
      );
    }

    const baldes = await SendLog.aggregate<{ _id: Date } & TotaisEnvio>([
      { $match: { createdAt: { $gte: de, $lte: ate } } },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$createdAt',
              unit: agrupamento,
              timezone: FUSO,
              startOfWeek: 'monday',
            },
          },
          registros: { $sum: 1 },
          // Pelo carimbo de envio: o status atual pode já ter virado aberto ou clicado.
          enviados: { $sum: { $cond: [{ $ne: ['$sentAt', null] }, 1, 0] } },
          abertos: { $sum: { $cond: [{ $ne: ['$openedAt', null] }, 1, 0] } },
          clicados: { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } },
          falhas: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          bounces: { $sum: { $cond: [{ $eq: ['$status', 'bounced'] }, 1, 0] } },
          descadastros: { $sum: { $cond: [{ $eq: ['$status', 'unsubscribed'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const totais = zerado();
    const serie: PontoEnvio[] = baldes.map((b) => {
      totais.registros += b.registros;
      totais.enviados += b.enviados;
      totais.abertos += b.abertos;
      totais.clicados += b.clicados;
      totais.falhas += b.falhas;
      totais.bounces += b.bounces;
      totais.descadastros += b.descadastros;

      return {
        inicio: new Date(b._id).toISOString(),
        registros: b.registros,
        enviados: b.enviados,
        abertos: b.abertos,
        clicados: b.clicados,
        falhas: b.falhas,
        bounces: b.bounces,
        descadastros: b.descadastros,
      };
    });

    const taxa = (parte: number) => (totais.enviados ? Math.round((parte / totais.enviados) * 1000) / 10 : 0);

    return {
      de: de.toISOString(),
      ate: ate.toISOString(),
      agrupamento,
      totais,
      taxas: { abertura: taxa(totais.abertos), clique: taxa(totais.clicados), falha: taxa(totais.falhas) },
      serie,
    };
  }
}

export default new SendReportService();
