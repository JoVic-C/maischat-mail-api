import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../../app';
import { runWithTenant } from '../../config/tenantContext';
import Campaign from '../../models/Campaign';
import SendLog from '../../models/SendLog';
import { criarCliente } from './fabricas';

async function criarEnvios(tenantId: Types.ObjectId | string, envios: Array<Record<string, unknown>>) {
  return runWithTenant(tenantId, async () => {
    const campanha = await Campaign.create({
      name: 'Campanha',
      templateId: new Types.ObjectId(),
      listIds: [new Types.ObjectId()],
      subject: 'Assunto',
      status: 'completed',
    });
    await SendLog.create(envios.map((e) => ({ campaignId: campanha._id, contactId: new Types.ObjectId(), ...e })));
    return campanha;
  });
}

function emBrasilia(dia: string, hora: string): Date {
  return new Date(`${dia}T${hora}:00.000-03:00`);
}

describe('relatório de envios da conta', () => {
  it('soma os envios do período e calcula as taxas', async () => {
    const a = await criarCliente('Cliente A');
    const agora = new Date();
    await criarEnvios(a.tenant._id, [
      { email: 'ana@x.com', status: 'opened', createdAt: agora, sentAt: agora, openedAt: agora },
      { email: 'bruno@x.com', status: 'clicked', createdAt: agora, sentAt: agora, openedAt: agora, clickedAt: agora },
      { email: 'carla@x.com', status: 'failed', createdAt: agora },
      { email: 'diego@x.com', status: 'bounced', createdAt: agora },
    ]);

    const res = await request(app).get('/api/dashboard/sends').set(a.auth).expect(200);

    expect(res.body.totais.registros).toBe(4);
    expect(res.body.totais.enviados).toBe(2);
    expect(res.body.totais.abertos).toBe(2);
    expect(res.body.totais.clicados).toBe(1);
    expect(res.body.totais.falhas).toBe(1);
    expect(res.body.totais.bounces).toBe(1);
    // As taxas são sobre os ENVIADOS, não sobre o total de registros.
    expect(res.body.taxas.abertura).toBe(100);
    expect(res.body.taxas.clique).toBe(50);
  });

  it('não conta envios de outro cliente', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const agora = new Date();
    await criarEnvios(a.tenant._id, [{ email: 'meu@x.com', status: 'sent', createdAt: agora, sentAt: agora }]);
    await criarEnvios(b.tenant._id, [{ email: 'alheio@x.com', status: 'sent', createdAt: agora, sentAt: agora }]);

    const res = await request(app).get('/api/dashboard/sends').set(a.auth).expect(200);

    expect(res.body.totais.registros).toBe(1);
    expect(res.body.totais.enviados).toBe(1);
  });

  it('recorta pelo período pedido, deixando de fora o que está antes', async () => {
    const a = await criarCliente('Cliente A');
    const hoje = new Date();
    const antigo = new Date(hoje.getTime() - 60 * 86_400_000);
    await criarEnvios(a.tenant._id, [
      { email: 'recente@x.com', status: 'sent', createdAt: hoje, sentAt: hoje },
      { email: 'antigo@x.com', status: 'sent', createdAt: antigo, sentAt: antigo },
    ]);

    // Padrão são 30 dias: o de 60 dias atrás não entra.
    const padrao = await request(app).get('/api/dashboard/sends').set(a.auth).expect(200);
    expect(padrao.body.totais.registros).toBe(1);

    const amplo = await request(app)
      .get('/api/dashboard/sends')
      .query({ de: new Date(hoje.getTime() - 90 * 86_400_000).toISOString(), agrupamento: 'month' })
      .set(a.auth)
      .expect(200);
    expect(amplo.body.totais.registros).toBe(2);
  });

  it('agrupa por dia usando o fuso de Brasília, não UTC', async () => {
    // 21h em Brasília já é o dia seguinte em UTC.
    const a = await criarCliente('Cliente A');
    const noite = emBrasilia('2026-09-02', '21:30');
    await criarEnvios(a.tenant._id, [{ email: 'ana@x.com', status: 'sent', createdAt: noite, sentAt: noite }]);

    const res = await request(app)
      .get('/api/dashboard/sends')
      .query({ de: '2026-09-01T00:00:00-03:00', ate: '2026-09-03T23:59:59-03:00', agrupamento: 'day' })
      .set(a.auth)
      .expect(200);

    expect(res.body.serie).toHaveLength(1);
    // O balde começa às 00h de 02/09 em Brasília = 03h UTC.
    expect(res.body.serie[0].inicio).toBe('2026-09-02T03:00:00.000Z');
  });

  it('agrupa por semana e por mês quando pedido', async () => {
    const a = await criarCliente('Cliente A');
    const dia1 = emBrasilia('2026-09-01', '10:00');
    const dia2 = emBrasilia('2026-09-03', '10:00');
    await criarEnvios(a.tenant._id, [
      { email: 'ana@x.com', status: 'sent', createdAt: dia1, sentAt: dia1 },
      { email: 'bruno@x.com', status: 'sent', createdAt: dia2, sentAt: dia2 },
    ]);

    const janela = { de: '2026-09-01T00:00:00-03:00', ate: '2026-09-30T23:59:59-03:00' };

    const porDia = await request(app)
      .get('/api/dashboard/sends')
      .query({ ...janela, agrupamento: 'day' })
      .set(a.auth)
      .expect(200);
    expect(porDia.body.serie).toHaveLength(2);

    // Mesma semana e mesmo mês: os dois envios colapsam num balde só.
    const porSemana = await request(app)
      .get('/api/dashboard/sends')
      .query({ ...janela, agrupamento: 'week' })
      .set(a.auth)
      .expect(200);
    expect(porSemana.body.serie).toHaveLength(1);
    expect(porSemana.body.serie[0].enviados).toBe(2);

    const porMes = await request(app)
      .get('/api/dashboard/sends')
      .query({ ...janela, agrupamento: 'month' })
      .set(a.auth)
      .expect(200);
    expect(porMes.body.serie).toHaveLength(1);
  });

  it('recusa período invertido em vez de devolver vazio em silêncio', async () => {
    const a = await criarCliente('Cliente A');
    await request(app)
      .get('/api/dashboard/sends')
      .query({ de: '2026-09-10T00:00:00Z', ate: '2026-09-01T00:00:00Z' })
      .set(a.auth)
      .expect(400);
  });

  it('recusa janela longa demais para o agrupamento pedido', async () => {
    // Cinco anos por dia dariam quase 2 mil barras — ilegível e caro de montar.
    const a = await criarCliente('Cliente A');
    const res = await request(app)
      .get('/api/dashboard/sends')
      .query({ de: '2021-01-01T00:00:00Z', ate: '2026-01-01T00:00:00Z', agrupamento: 'day' })
      .set(a.auth)
      .expect(400);

    expect(res.body.error).toMatch(/período longo/i);
  });

  it('recusa agrupamento que não existe', async () => {
    const a = await criarCliente('Cliente A');
    await request(app).get('/api/dashboard/sends').query({ agrupamento: 'hora' }).set(a.auth).expect(400);
  });

  it('sem token não devolve nada', async () => {
    await request(app).get('/api/dashboard/sends').expect(401);
  });

  it('conta sem envios devolve zeros, não erro', async () => {
    const a = await criarCliente('Cliente A');
    const res = await request(app).get('/api/dashboard/sends').set(a.auth).expect(200);

    expect(res.body.totais.enviados).toBe(0);
    expect(res.body.serie).toEqual([]);
    expect(res.body.taxas.abertura).toBe(0);
  });
});
