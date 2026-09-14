/**
 * Escrita de .xlsx direto na resposta HTTP, linha a linha, com memória constante. Datas
 * vão como data de verdade, para o Excel ordenar e filtrar por período.
 */
import ExcelJS from 'exceljs';
import type { Response } from 'express';

/** Teto de linhas do Excel menos o cabeçalho. Acima disso o arquivo sai, mas não abre. */
export const XLSX_MAX_LINHAS = 1_048_575;

const FORMATO_DATA = 'dd/mm/yyyy hh:mm';

export interface ColunaXlsx {
  titulo: string;
  largura?: number;
  data?: boolean;
}

export interface EscritorXlsx {
  addRow(valores: unknown[]): void;
  finish(): Promise<void>;
}

export function deveUsarCsv(totalLinhas: number): boolean {
  return totalLinhas > XLSX_MAX_LINHAS;
}

/** Sem `Content-Length`: o tamanho só existe depois de o arquivo inteiro ser montado. */
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
    // Strings compartilhadas manteriam todo o texto do arquivo em memória.
    useSharedStrings: false,
    // Necessário para o formato de data.
    useStyles: true,
  });

  // No escritor em streaming `views` é somente leitura: tem que ir na criação da aba.
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
