import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../../app';
import { runWithTenant } from '../../config/tenantContext';
import Campaign from '../../models/Campaign';
import SendLog from '../../models/SendLog';
import { criarCliente } from './fabricas';

async function campanhaComEnvios(
  tenantId: Types.ObjectId | string,
  nome: string,
  envios: Array<Record<string, unknown>>
) {
  return runWithTenant(tenantId, async () => {
    // templateId e listIds são obrigatórios no schema, mas o relatório não os usa.
    const campanha = await Campaign.create({
      name: nome,
      templateId: new Types.ObjectId(),
      listIds: [new Types.ObjectId()],
      subject: 'Assunto',
      status: 'completed',
    });
    await SendLog.create(
      envios.map((e) => ({
        campaignId: campanha._id,
        contactId: new Types.ObjectId(),
        ...e,
      }))
    );
    return campanha;
  });
}

// Parser próprio: o supertest interpretaria o corpo pelo Content-Type e estragaria os bytes do .xlsx.
function baixar(url: string, auth: Record<string, string>, query: Record<string, string> = {}) {
  return request(app)
    .get(url)
    .query(query)
    .set(auth)
    .buffer(true)
    .parse((res, cb) => {
      const partes: Buffer[] = [];
      res.on('data', (c: Buffer) => partes.push(c));
      res.on('end', () => cb(null, Buffer.concat(partes)));
    });
}

async function lerXlsx(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const linhas: string[][] = [];
  wb.worksheets[0].eachRow((row) => {
    const valores = (row.values as unknown[]).slice(1);
    linhas.push(valores.map((v) => (v instanceof Date ? v.toISOString() : String(v ?? ''))));
  });
  return linhas;
}

describe('relatório de envios', () => {
  it('sai em .xlsx por padrão, com cabeçalho e uma linha por envio', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaComEnvios(a.tenant._id, 'Newsletter de Julho', [
      { email: 'ana@x.com', status: 'opened', openCount: 2 },
      { email: 'bruno@x.com', status: 'bounced', error: 'mailbox not found' },
    ]);

    const res = await baixar(`/api/campaigns/${campanha._id}/report`, a.auth).expect(200);

    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('envios-newsletter-de-julho-');
    expect(res.headers['content-disposition']).toContain('.xlsx');

    const linhas = await lerXlsx(res.body as Buffer);
    expect(linhas).toHaveLength(3);
    expect(linhas[0][0]).toBe('Email');
    expect(linhas.flat().join(' ')).toContain('ana@x.com');
    expect(linhas.flat().join(' ')).toContain('mailbox not found');
  });

  it('grava data como DATA, não como texto — é o que deixa ordenar e filtrar no Excel', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaComEnvios(a.tenant._id, 'Campanha', [
      { email: 'ana@x.com', status: 'sent', sentAt: new Date('2026-07-15T13:45:00.000Z') },
    ]);

    const res = await baixar(`/api/campaigns/${campanha._id}/report`, a.auth).expect(200);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    // Coluna 3 = "Enviado em".
    expect(wb.worksheets[0].getRow(2).getCell(3).value).toBeInstanceOf(Date);
  });

  it('traduz a situação para português', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaComEnvios(a.tenant._id, 'Campanha', [{ email: 'ana@x.com', status: 'bounced' }]);

    const res = await baixar(`/api/campaigns/${campanha._id}/report`, a.auth).expect(200);
    const linhas = await lerXlsx(res.body as Buffer);

    expect(linhas[1][1]).toBe('Bounce');
  });

  it('filtra por situação quando pedido', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaComEnvios(a.tenant._id, 'Campanha', [
      { email: 'ana@x.com', status: 'opened' },
      { email: 'bruno@x.com', status: 'bounced' },
    ]);

    const res = await baixar(`/api/campaigns/${campanha._id}/report`, a.auth, { status: 'bounced' }).expect(200);
    const texto = (await lerXlsx(res.body as Buffer)).flat().join(' ');

    expect(texto).toContain('bruno@x.com');
    expect(texto).not.toContain('ana@x.com');
  });

  it('entrega CSV quando pedido explicitamente', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaComEnvios(a.tenant._id, 'Campanha', [
      { email: 'ana@x.com', status: 'failed', error: 'recusado: "quota exceeded"' },
    ]);

    const res = await request(app)
      .get(`/api/campaigns/${campanha._id}/report`)
      .query({ format: 'csv' })
      .set(a.auth)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Email;Situação');
    expect(res.text).toContain('""quota exceeded""');
  });

  it('recusa um formato que não existe', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaComEnvios(a.tenant._id, 'Campanha', [{ email: 'ana@x.com', status: 'sent' }]);

    await request(app).get(`/api/campaigns/${campanha._id}/report`).query({ format: 'pdf' }).set(a.auth).expect(400);
  });

  it('recusa uma situação que não existe', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaComEnvios(a.tenant._id, 'Campanha', [{ email: 'ana@x.com', status: 'sent' }]);

    await request(app)
      .get(`/api/campaigns/${campanha._id}/report`)
      .query({ status: 'inventado' })
      .set(a.auth)
      .expect(400);
  });

  it('NÃO entrega o relatório de uma campanha de outro cliente', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const alheia = await campanhaComEnvios(b.tenant._id, 'Campanha do B', [{ email: 'segredo@x.com', status: 'sent' }]);

    const res = await request(app).get(`/api/campaigns/${alheia._id}/report`).set(a.auth).expect(404);
    expect(res.text).not.toContain('segredo@x.com');
  });

  it('sem token não baixa nada', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaComEnvios(a.tenant._id, 'Campanha', [{ email: 'ana@x.com', status: 'sent' }]);

    await request(app).get(`/api/campaigns/${campanha._id}/report`).expect(401);
  });

  it('campanha sem envios devolve a planilha só com o cabeçalho, não um erro', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaComEnvios(a.tenant._id, 'Campanha vazia', []);

    const res = await baixar(`/api/campaigns/${campanha._id}/report`, a.auth).expect(200);
    expect(await lerXlsx(res.body as Buffer)).toHaveLength(1);
  });
});
