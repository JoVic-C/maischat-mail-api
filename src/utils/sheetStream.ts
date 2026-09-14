/** Entrada única para arquivos de contatos: CSV e planilha viram a mesma sequência de linhas. */
import path from 'node:path';
import type { CsvRow } from './csv';
import { streamCsvRows } from './csvStream';
import { streamXlsxRows } from './xlsxStream';

export const SHEET_EXTENSIONS = ['.csv', '.txt', '.xlsx'] as const;

export function sheetExtension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

export function isSupportedSheet(fileName: string): boolean {
  return (SHEET_EXTENSIONS as readonly string[]).includes(sheetExtension(fileName));
}

/** O .xls antigo é binário e não é lido; tem mensagem própria em vez de "arquivo inválido". */
export function isLegacyExcel(fileName: string): boolean {
  return sheetExtension(fileName) === '.xls';
}

export function streamSheetRows(filePath: string): AsyncGenerator<CsvRow> {
  return sheetExtension(filePath) === '.xlsx' ? streamXlsxRows(filePath) : streamCsvRows(filePath);
}
