/**
 * Leitura de CSV em streaming, linha a linha.
 *
 * Existe em paralelo ao `parseCsv` (que devolve tudo de uma vez e continua servindo
 * a entradas pequenas): um arquivo de 100 MB não cabe em memória como string, e o
 * array de objetos correspondente é ainda maior. Aqui o arquivo nunca é
 * materializado — o consumidor recebe um lote por vez e decide o que guardar.
 *
 * Limitação herdada do parser original: campos entre aspas com quebra de linha
 * DENTRO não são suportados (a unidade de leitura é a linha física). Vale para os
 * dois caminhos, então não é regressão.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { type CsvRow, detectDelimiter, splitLine } from './csv';

export async function* streamCsvRows(filePath: string): AsyncGenerator<CsvRow> {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  let headers: string[] | null = null;
  let delimiter = ',';

  try {
    for await (const raw of rl as AsyncIterable<string>) {
      const line: string = headers === null ? raw.replace(/^\uFEFF/, '') : raw;
      if (!line.trim()) continue;

      if (headers === null) {
        delimiter = detectDelimiter(line);
        headers = splitLine(line, delimiter).map((h) => h.toLowerCase());
        continue;
      }

      const values = splitLine(line, delimiter);
      const row: CsvRow = {};
      headers.forEach((h, i) => {
        row[h] = values[i] ?? '';
      });
      yield row;
    }
  } finally {
    // Encerra o descritor mesmo se o consumidor abandonar o generator (break/erro).
    rl.close();
    input.destroy();
  }
}

/** Agrupa um AsyncIterable em lotes de tamanho fixo (o último sai parcial). */
export async function* inBatches<T>(source: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let batch: T[] = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
