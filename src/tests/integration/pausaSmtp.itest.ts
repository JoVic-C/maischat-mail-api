import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { runWithTenant } from '../../config/tenantContext';
import Campaign from '../../models/Campaign';
import campaignService from '../../services/campaign.service';
import { criarCliente } from './fabricas';

// As queries são aguardadas DENTRO do runWithTenant: a Query do Mongoose só executa no await.
describe('pausa por falha de login no SMTP', () => {
  async function campanhaEnviando(tenantId: Types.ObjectId) {
    return runWithTenant(
      tenantId,
      async () =>
        await Campaign.create({
          name: 'Teste de HTML',
          templateId: new Types.ObjectId(),
          listIds: [new Types.ObjectId()],
          subject: 'Assunto',
          status: 'sending',
          stats: { total: 1 },
        })
    );
  }

  it('retomar limpa o motivo da pausa automática', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaEnviando(a.tenant._id);

    // O mesmo update que o worker faz ao receber 535 do servidor.
    await runWithTenant(
      a.tenant._id,
      async () =>
        await Campaign.updateOne(
          { _id: campanha._id, status: 'sending' },
          { status: 'paused', pauseReason: 'Falha de login no servidor SMTP.' }
        )
    );

    await runWithTenant(a.tenant._id, async () => await campaignService.resume(String(campanha._id)));

    const depois = await runWithTenant(a.tenant._id, async () => await Campaign.findById(campanha._id).lean());
    expect(depois?.status).toBe('sending');
    expect(depois?.pauseReason).toBeNull();
  });

  it('a transição só acontece a partir de "sending" — envios simultâneos não brigam', async () => {
    const a = await criarCliente('Cliente A');
    const campanha = await campanhaEnviando(a.tenant._id);
    const pausar = () =>
      runWithTenant(
        a.tenant._id,
        async () =>
          await Campaign.updateOne({ _id: campanha._id, status: 'sending' }, { status: 'paused', pauseReason: 'SMTP' })
      );

    const resultados = await Promise.all([pausar(), pausar(), pausar(), pausar(), pausar()]);
    const transicoes = resultados.reduce((n, r) => n + r.modifiedCount, 0);

    expect(transicoes).toBe(1);
  });
});
