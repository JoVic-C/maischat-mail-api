import ExcelJS from 'exceljs';

export interface InvalidRow {
  email: string;
  name: string;
  reason: string;
}

export async function buildInvalidExcel(rows: InvalidRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contatos incorretos');

  ws.columns = [
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Nome', key: 'name', width: 24 },
    { header: 'Motivo', key: 'reason', width: 28 },
  ];

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };

  for (const r of rows) ws.addRow(r);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
