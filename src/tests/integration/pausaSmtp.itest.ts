import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { runWithTenant } from '../../config/tenantContext';
import Campaign from '../../models/Campaign';
import SmtpSettings from '../../models/SmtpSettings';
import campaignService from '../../services/campaign.service';
import smtpService, { FALLBACK_SMTP_ID } from '../../services/smtp.service';
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

  it('falha com credenciais já substituídas não conta: o SMTP foi corrigido depois', async () => {
    const a = await criarCliente('Cliente A');
    const smtp = await runWithTenant(
      a.tenant._id,
      async () =>
        await SmtpSettings.create({
          name: 'Cliente',
          host: 'smtp.cliente.com',
          port: 587,
          user: 'envio',
          password: 'senha-errada',
          fromName: 'Cliente',
          fromEmail: 'envio@cliente.com',
        })
    );
    const lidoPeloEnvio = smtp.updatedAt;

    const antes = await runWithTenant(a.tenant._id, () => smtpService.changedSince(String(smtp._id), lidoPeloEnvio));
    expect(antes).toBe(false);

    // O usuário corrige a senha enquanto o envio estava em curso.
    await new Promise((r) => setTimeout(r, 5));
    await runWithTenant(a.tenant._id, async () => {
      smtp.password = 'senha-certa';
      await smtp.save();
    });

    const depois = await runWithTenant(a.tenant._id, () => smtpService.changedSince(String(smtp._id), lidoPeloEnvio));
    expect(depois).toBe(true);
  });

  it('o SMTP da plataforma vem do ambiente e nunca conta como alterado', async () => {
    expect(await smtpService.changedSince(FALLBACK_SMTP_ID, new Date())).toBe(false);
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
