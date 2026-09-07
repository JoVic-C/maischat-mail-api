/**
 * Leitura de .xlsx em streaming, linha a linha.
 *
 * Mesma forma do `streamCsvRows`: devolve um objeto por linha, com as chaves vindas
 * do cabeçalho em minúsculas — assim o resto da importação não precisa saber se a
 * origem foi planilha ou texto.
 *
 * Só a PRIMEIRA aba é lida. Uma planilha de contatos com várias abas quase sempre
 * tem as outras como apoio (listas de validação, rascunhos), e importar tudo
 * silenciosamente traria lixo para a base.
 *
 * Limite conhecido: o .xlsx guarda os textos numa tabela compartilhada, que precisa
 * estar em memória para as células serem resolvidas. Para arquivos muito grandes
 * (centenas de milhares de linhas) o CSV continua sendo o caminho mais leve.
 */
import ExcelJS from 'exceljs';
import type { CsvRow } from './csv';

interface RichTextRun {
  text?: unknown;
}

/**
 * Converte o valor de uma célula em texto.
 *
 * O Excel não devolve string pura: um email digitado vira objeto de hyperlink, um
 * texto formatado vira lista de trechos, e uma fórmula vira `{ formula, result }`.
 * Ler `String(value)` nesses casos produziria `[object Object]` no lugar do email.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // Hyperlink: o Excel converte email digitado em link. O rótulo é o que interessa.
    if (typeof obj.text === 'string') return obj.text.trim();
    if (Array.isArray(obj.richText)) {
      // Junta primeiro e apara UMA vez no fim: aparar cada trecho comeria o espaço
      // entre eles, e "Carla " + "Dias" viraria "CarlaDias".
      return (obj.richText as RichTextRun[])
        .map((r) => (typeof r.text === 'string' ? r.text : cellText(r.text)))
        .join('')
        .trim();
    }
    // Fórmula: vale o resultado calculado, não a expressão.
    if ('result' in obj) return cellText(obj.result);
    if (typeof obj.hyperlink === 'string') return obj.hyperlink.replace(/^mailto:/i, '').trim();
    if ('error' in obj) return ''; // célula em #N/A, #VALOR! etc.

    // Formato de célula que não conhecemos. Cair no String(value) devolveria
    // "[object Object]", que entraria na base como se fosse o nome ou o email da
    // pessoa. Vazio é honesto: a linha é recusada na validação em vez de importar lixo.
    return '';
  }

  return String(value).trim();
}

/** Converte a linha do exceljs (array base 1, esparso) em textos base 0. */
function rowCells(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  // Laço em vez de slice().map(): o array vem ESPARSO (colunas vazias viram buracos)
  // e o map pula buracos, o que desalinharia as células em relação ao cabeçalho.
  for (let i = 1; i < values.length; i++) out.push(cellText(values[i]));
  return out;
}

export async function* streamXlsxRows(filePath: string): AsyncGenerator<CsvRow> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit',
    sharedStrings: 'cache', // sem isto as células de texto chegam como índice, não como valor
    hyperlinks: 'cache', // emails costumam virar link ao serem digitados
    styles: 'ignore',
    // `entries: 'ignore'` NÃO serve aqui: sem processar as entradas do pacote, o
    // leitor não monta o mapa de abas e quebra ao abrir a primeira planilha.
    entries: 'emit',
  });

  // Contorno de um defeito do exceljs 4.4: ao abrir uma aba ele consulta
  // `this.model.sheets` para descobrir o nome dela, mas `model` só é preenchido
  // quando `xl/workbook.xml` aparece no zip — e nem todo gerador coloca esse arquivo
  // antes das planilhas (o próprio exceljs o grava por último). Nesse caso a leitura
  // morre com "Cannot read properties of undefined (reading 'sheets')".
  // Semear a estrutura vazia faz a consulta não encontrar nada e seguir com o nome
  // padrão da aba — que não usamos, já que só interessam as linhas.
  (reader as unknown as { model: { sheets: unknown[] } }).model = { sheets: [] };

  let headers: string[] | null = null;

  for await (const worksheet of reader) {
    for await (const row of worksheet) {
      const cells = rowCells(row.values);
      if (cells.every((c) => !c)) continue; // linha em branco (comum antes do cabeçalho)

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
    // Só a primeira aba: sair do laço encerra o leitor pelo `return()` do iterador.
    break;
  }
}
