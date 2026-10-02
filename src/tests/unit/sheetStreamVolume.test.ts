import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { inBatches } from '../../utils/csvStream';
import { streamSheetRows } from '../../utils/sheetStream';

const LINHAS = 5000;

function linha(i: number): [string, string, string] {
  return [`Contato ${i}`, `contato${i}@exemplo.com.br`, 'ACME'];
}

async function gravarCsv(arquivo: string): Promise<void> {
  const linhas = Array.from({ length: LINHAS }, (_, i) => linha(i).join(';'));
  fs.writeFileSync(arquivo, `nome;email;empresa\n${linhas.join('\n')}\n`);
}

async function gravarXlsx(arquivo: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const aba = workbook.addWorksheet('Contatos');
  aba.addRow(['nome', 'email', 'empresa']);
  for (let i = 0; i < LINHAS; i++) aba.addRow(linha(i));
  await workbook.xlsx.writeFile(arquivo);
}

describe('leitura de arquivos acima de 2.000 linhas', () => {
  let arquivo = '';

  afterEach(() => {
    if (arquivo) fs.rmSync(arquivo, { force: true });
  });

  it.each([
    ['csv', gravarCsv],
    ['xlsx', gravarXlsx],
  ] as const)('entrega todas as linhas de um .%s, em lotes', async (extensao, gravar) => {
    arquivo = path.join(os.tmpdir(), `volume-${Date.now()}.${extensao}`);
    await gravar(arquivo);

    let total = 0;
    let ultimoEmail = '';
    for await (const lote of inBatches(streamSheetRows(arquivo), 200)) {
      total += lote.length;
      ultimoEmail = lote[lote.length - 1].email;
    }

    expect(total).toBe(LINHAS);
    expect(ultimoEmail).toBe(`contato${LINHAS - 1}@exemplo.com.br`);
  });
});
