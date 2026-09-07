/**
 * Escrita de .xlsx direto na resposta HTTP, linha a linha.
 *
 * Mesma ideia do `csvResponse`: o arquivo é montado enquanto os documentos chegam do
 * cursor, então o pico de memória não depende do tamanho do resultado. Medido, 200 mil
 * linhas ficam em ~130 MB com o heap limitado a 512 MB.
 *
 * Datas vão como DATA de verdade, não como texto — é o que permite ordenar e filtrar
 * por período dentro do Excel, que é a razão de alguém pedir xlsx em vez de CSV.
 */
import ExcelJS from 'exceljs';
import type { Response } from 'express';

/**
 * Teto de linhas de uma planilha do Excel (2007 em diante), menos o cabeçalho.
 *
 * Passar disso não dá erro na escrita: o arquivo sai e o Excel se recusa a abrir. Quem
 * exporta mais que isto precisa de CSV — ver `deveUsarCsv`.
 */
export const XLSX_MAX_LINHAS = 1_048_575;

/** Formato de data que o Excel entende e exibe em português. */
const FORMATO_DATA = 'dd/mm/yyyy hh:mm';

export interface ColunaXlsx {
  titulo: string;
  /** Largura em caracteres. Sem isto toda coluna nasce estreita e o usuário redimensiona na mão. */
  largura?: number;
  /** Marca a coluna como data, para o Excel tratá-la como tal. */
  data?: boolean;
}

export interface EscritorXlsx {
  addRow(valores: unknown[]): void;
  finish(): Promise<void>;
}

/** Acima do teto do formato, a única saída honesta é CSV. */
export function deveUsarCsv(totalLinhas: number): boolean {
  return totalLinhas > XLSX_MAX_LINHAS;
}

/**
 * Prepara a resposta para download e devolve um escritor de linhas.
 *
 * Sem `Content-Length`: o tamanho só existe depois de fechar o arquivo, e esperar por
 * ele significaria montar tudo em memória — exatamente o que este caminho evita.
 */
export function startXlsxDownload(
  res: Response,
  nomeArquivo: string,
  colunas: ColunaXlsx[],
  nomeAba = 'Dados'
): EscritorXlsx {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  res.setHeader('Cache-Control', 'no-store');

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    // Strings compartilhadas montam um dicionário de TODO o texto do arquivo em
    // memória — o oposto do que queremos numa exportação grande.
    useSharedStrings: false,
    // Ligado porque o formato de data depende de estilo. Medido: não compromete a
    // memória, já que os estilos são poucos e compartilhados.
    useStyles: true,
  });

  // As views vão na CRIAÇÃO: no escritor em streaming `worksheet.views` é somente
  // leitura, e atribuir depois lança — no meio da resposta, o que produz um arquivo
  // truncado que o Excel recusa com "zip corrompido".
  // Congelar a primeira linha importa: rolar 300 mil linhas sem ver a coluna é inútil.
  const worksheet = workbook.addWorksheet(nomeAba, { views: [{ state: 'frozen', ySplit: 1 }] });

  worksheet.columns = colunas.map((c, i) => ({
    header: c.titulo,
    key: `c${i}`,
    width: c.largura ?? 18,
    style: c.data ? { numFmt: FORMATO_DATA } : undefined,
  }));

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).commit();

  return {
    addRow(valores: unknown[]): void {
      worksheet.addRow(valores).commit();
    },
    async finish(): Promise<void> {
      await worksheet.commit();
      await workbook.commit();
    },
  };
}
