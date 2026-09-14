/**
 * Leitura de CSV em streaming, linha a linha, para arquivos que não cabem em memória
 * (o `parseCsv` continua servindo entradas pequenas). Campos entre aspas com quebra de
 * linha dentro não são suportados: a unidade de leitura é a linha física.
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
