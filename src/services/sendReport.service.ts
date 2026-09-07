/**
 * Relatório de envios da conta, por período.
 *
 * Diferente do relatório de UMA campanha (campaignReport), este atravessa todas as
 * campanhas do cliente e responde "quanto saiu, quanto abriu, quanto falhou" numa
 * janela de tempo — é o que o dashboard mostra.
 *
 * Os números saem de uma agregação sobre o SendLog, e não da soma de `Campaign.stats`,
 * porque só o log tem a DATA de cada envio. As estatísticas da campanha são um total
 * acumulado: não dá para recortar "a semana passada" a partir delas.
 */

import { BadRequestError } from '../errors';
import SendLog from '../models/SendLog';

export type Agrupamento = 'day' | 'week' | 'month';

/**
 * Fuso do recorte.
 *
 * Sem ele o Mongo corta os dias em UTC, e um envio das 21h no horário de Brasília cai
 * no dia seguinte do relatório — o operador compara com o que viu na tela e não bate.
 */
const FUSO = 'America/Sao_Paulo';

/**
 * Teto de pontos na série.
 *
 * Protege os dois lados: uma consulta de cinco anos agrupada por dia devolveria
 * milhares de pontos, ilegíveis no gráfico e caros de montar. Passando disso, a
 * resposta é um erro que sugere agrupar mais grosso, em vez de um gráfico inútil.
 */
const MAX_PONTOS = 400;

/** Janela padrão quando o pedido não traz datas. */
const DIAS_PADRAO = 30;

export interface TotaisEnvio {
  /** Linhas de envio no período — inclui as que ainda não saíram. */
  registros: number;
  enviados: number;
  abertos: number;
  clicados: number;
  falhas: number;
  bounces: number;
  descadastros: number;
}

export interface PontoEnvio extends TotaisEnvio {
  /** Início do balde, em ISO. O rótulo é montado na tela, que conhece o idioma. */
  inicio: string;
}

export interface RelatorioEnvios {
  de: string;
  ate: string;
  agrupamento: Agrupamento;
  totais: TotaisEnvio;
  /** Percentuais sobre os ENVIADOS, não sobre os registros — é a leitura usual. */
  taxas: { abertura: number; clique: number; falha: number };
  serie: PontoEnvio[];
}

export interface FiltroRelatorio {
  de?: string;
  ate?: string;
  agrupamento?: Agrupamento;
}

/** Quantos dias cabem num balde — usado só para prever o tamanho da série. */
const DIAS_POR_BALDE: Record<Agrupamento, number> = { day: 1, week: 7, month: 28 };

function zerado(): TotaisEnvio {
  return { registros: 0, enviados: 0, abertos: 0, clicados: 0, falhas: 0, bounces: 0, descadastros: 0 };
}

function parseData(valor: string | undefined, padrao: Date, campo: string): Date {
  if (!valor) return padrao;
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) throw new BadRequestError(`Data inválida em "${campo}".`);
  return data;
}

export class SendReportService {
  /**
   * Números do período, agrupados por dia, semana ou mês.
   *
   * A consulta sai escopada pelo cliente (plugin tenantScope) e usa o índice composto
   * {tenantId, createdAt} — sem ele, uma instalação com vários clientes varreria a
   * janela de todos para responder a de um.
   */
  async gerar(filtro: FiltroRelatorio = {}): Promise<RelatorioEnvios> {
    const agrupamento = filtro.agrupamento ?? 'day';
    if (!['day', 'week', 'month'].includes(agrupamento)) {
      throw new BadRequestError('Agrupamento inválido. Use day, week ou month.');
    }

    const agora = new Date();
    const ate = parseData(filtro.ate, agora, 'ate');
    const de = parseData(filtro.de, new Date(agora.getTime() - DIAS_PADRAO * 86_400_000), 'de');

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
              // Semana começando na segunda: é como o calendário brasileiro é lido.
              startOfWeek: 'monday',
            },
          },
          registros: { $sum: 1 },
          // "Enviado" é ter saído de fato — o carimbo de envio, não o status atual,
          // que já pode ter virado aberto ou clicado.
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

    // Os totais saem da soma dos baldes, em vez de uma segunda agregação: o resultado é
    // o mesmo e evita percorrer a coleção duas vezes.
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
