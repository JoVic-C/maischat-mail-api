/**
 * Leitura de .xlsx em streaming, no mesmo formato de `streamCsvRows`: um objeto por
 * linha, com as chaves do cabeçalho em minúsculas.
 *
 * Só a primeira aba é lida; as demais costumam ser apoio. O .xlsx guarda os textos numa
 * tabela compartilhada que precisa caber em memória, então para arquivos muito grandes o
 * CSV é o caminho mais leve.
 */
import ExcelJS from 'exceljs';
import type { CsvRow } from './csv';

interface RichTextRun {
  text?: unknown;
}

/**
 * O Excel não devolve string pura: email digitado vira hyperlink, texto formatado vira
 * lista de trechos e fórmula vira `{ formula, result }`. `String(value)` produziria
 * `[object Object]`.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    if (typeof obj.text === 'string') return obj.text.trim();
    if (Array.isArray(obj.richText)) {
      // Junta antes de aparar: aparar cada trecho comeria o espaço entre eles.
      return (obj.richText as RichTextRun[])
        .map((r) => (typeof r.text === 'string' ? r.text : cellText(r.text)))
        .join('')
        .trim();
    }
    if ('result' in obj) return cellText(obj.result);
    if (typeof obj.hyperlink === 'string') return obj.hyperlink.replace(/^mailto:/i, '').trim();
    if ('error' in obj) return '';

    // Formato desconhecido: vazio faz a linha ser recusada, em vez de importar "[object Object]".
    return '';
  }

  return String(value).trim();
}

function rowCells(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  // O array vem esparso e `map` pula buracos, o que desalinharia as colunas.
  for (let i = 1; i < values.length; i++) out.push(cellText(values[i]));
  return out;
}

export async function* streamXlsxRows(filePath: string): AsyncGenerator<CsvRow> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'cache',
    styles: 'ignore',
    // Com 'ignore' o leitor não monta o mapa de abas e quebra ao abrir a primeira.
    entries: 'emit',
  });

  // Contorno do exceljs 4.4: `model.sheets` só existe se `xl/workbook.xml` vier antes das
  // planilhas no zip, o que nem todo gerador garante.
  (reader as unknown as { model: { sheets: unknown[] } }).model = { sheets: [] };

  let headers: string[] | null = null;

  for await (const worksheet of reader) {
    for await (const row of worksheet) {
      const cells = rowCells(row.values);
      if (cells.every((c) => !c)) continue;

      if (headers === null) {
        headers = cells.map((h) => h.toLowerCase());
        continue;
      }

      const out: CsvRow = {};
      headers.forEach((h, i) => {
        out[h] = cells[i] ?? '';
      });
      yield out;
    }
    break;
  }
}
