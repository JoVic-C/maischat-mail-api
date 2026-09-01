/**
 * Porta de entrada única para arquivos de contatos.
 *
 * A importação não deve saber se o operador subiu um CSV exportado do sistema antigo
 * ou a planilha que ele mantém no Excel: os dois viram a mesma sequência de linhas.
 */
import path from 'node:path';
import type { CsvRow } from './csv';
import { streamCsvRows } from './csvStream';
import { streamXlsxRows } from './xlsxStream';

/** Extensões aceitas no upload. `.xls` (formato binário antigo) fica de fora — ver abaixo. */
export const SHEET_EXTENSIONS = ['.csv', '.txt', '.xlsx'] as const;

export function sheetExtension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

export function isSupportedSheet(fileName: string): boolean {
  return (SHEET_EXTENSIONS as readonly string[]).includes(sheetExtension(fileName));
}

/**
 * O .xls antigo (Excel 97-2003) não é suportado: é um formato binário que a
 * biblioteca de planilhas do projeto não lê. Merece mensagem própria — dizer só
 * "arquivo inválido" para quem subiu uma planilha de verdade não ajuda ninguém.
 */
export function isLegacyExcel(fileName: string): boolean {
  return sheetExtension(fileName) === '.xls';
}

/** Percorre o arquivo linha a linha, escolhendo o leitor pela extensão. */
export function streamSheetRows(filePath: string): AsyncGenerator<CsvRow> {
  return sheetExtension(filePath) === '.xlsx' ? streamXlsxRows(filePath) : streamCsvRows(filePath);
}
