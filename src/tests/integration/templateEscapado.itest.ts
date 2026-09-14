import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../../app';
import { runWithTenant } from '../../config/tenantContext';
import Campaign from '../../models/Campaign';
import Template from '../../models/Template';
import { criarCliente } from './fabricas';

// A trava também fica no envio de teste e no disparo: o template pode ter sido salvo antes dela existir.
const ESCAPADO = '<div>&lt;!DOCTYPE html&gt;</div><div>&lt;html lang="pt-BR"&gt;</div>';

describe('template com HTML escapado', () => {
  it('salvar é recusado com instrução de como corrigir', async () => {
    const a = await criarCliente('Cliente A');

    const res = await request(app)
      .post('/api/templates/save')
      .set(a.auth)
      .send({ name: 'Newsletter', subject: 'Oi', html: ESCAPADO });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('HTML_ESCAPADO');
    expect(res.body.error).toMatch(/HTML avançado/);
  });

  it('um template corrompido já salvo não sai no envio de teste nem no disparo', async () => {
    const a = await criarCliente('Cliente A');

    const campanha = await runWithTenant(a.tenant._id, async () => {
      const template = await Template.create({ name: 'Antigo', subject: 'Oi', html: ESCAPADO, variables: [] });
      return await Campaign.create({
        name: 'Campanha',
        templateId: template._id,
        listIds: [new Types.ObjectId()],
        subject: 'Oi',
        status: 'draft',
      });
    });

    const teste = await request(app)
      .post(`/api/campaigns/${campanha._id}/test-email`)
      .set(a.auth)
      .send({ email: 'eu@exemplo.com' });
    expect(teste.status).toBe(400);
    expect(teste.body.code).toBe('HTML_ESCAPADO');

    const disparo = await request(app).post(`/api/campaigns/${campanha._id}/start`).set(a.auth).send({});
    expect(disparo.status).toBe(400);
    expect(disparo.body.code).toBe('HTML_ESCAPADO');

    const depois = await runWithTenant(a.tenant._id, async () => await Campaign.findById(campanha._id).lean());
    expect(depois?.status).toBe('draft');
  });

  it('email de verdade continua salvando normalmente', async () => {
    const a = await criarCliente('Cliente A');

    await request(app)
      .post('/api/templates/save')
      .set(a.auth)
      .send({ name: 'Newsletter', subject: 'Oi', html: '<!DOCTYPE html><html><body><p>Oi {{name}}</p></body></html>' })
      .expect((r) => expect([200, 201]).toContain(r.status));
  });
});
