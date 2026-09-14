import type { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../../app';
import { runWithTenant } from '../../config/tenantContext';
import Campaign from '../../models/Campaign';
import List from '../../models/List';
import SendingDomain from '../../models/SendingDomain';
import SmtpSettings from '../../models/SmtpSettings';
import Template from '../../models/Template';
import sendingDomainService, { DnsUnavailableError, type TxtLookup } from '../../services/sendingDomain.service';
import { criarCliente } from './fabricas';

const CHAVE = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAchave';

const DNS_OK: Record<string, string[]> = {
  'cliente.com.br': ['v=spf1 include:_spf.google.com include:maismail.com.br ~all'],
  'mmail._domainkey.cliente.com.br': [`v=DKIM1; k=rsa; p=${CHAVE}`],
  'mmail._domainkey.maismail.com.br': [`v=DKIM1; k=rsa; p=${CHAVE}`],
  '_dmarc.cliente.com.br': ['v=DMARC1; p=none'],
};

const DNS_SO_GOOGLE: Record<string, string[]> = {
  ...DNS_OK,
  'cliente.com.br': ['v=spf1 include:_spf.google.com ~all'],
};

function dns(records: Record<string, string[]>): TxtLookup {
  return async (name) => records[name] ?? [];
}

async function criarSmtp(tenantId: Types.ObjectId, host: string, fromEmail: string, name = 'Envio') {
  return runWithTenant(tenantId, async () =>
    SmtpSettings.create({
      name,
      host,
      port: 587,
      user: 'teste@maismail.com.br',
      password: 'senha',
      fromName: 'Cliente',
      fromEmail,
      isDefault: true,
    })
  );
}

async function criarCampanha(tenantId: Types.ObjectId, smtpId: Types.ObjectId) {
  return runWithTenant(tenantId, async () => {
    const template = await Template.create({ name: 'T', subject: 'Oi', html: '<p>Oi</p>', variables: [] });
    const lista = await List.create({ name: 'Vazia' });
    return Campaign.create({
      name: 'Campanha',
      templateId: template._id,
      listIds: [lista._id],
      subject: 'Oi',
      smtpId,
      status: 'draft',
    });
  });
}

describe('domínio de envio', () => {
  const env = { ...process.env };
  const lookupOriginal = sendingDomainService.lookupTxt;

  beforeEach(() => {
    process.env.SENDING_PLATFORM_HOSTS = 'mail.maismail.com.br';
    process.env.SENDING_SPF_INCLUDE = 'maismail.com.br';
    process.env.SENDING_DKIM_SELECTOR = 'mmail';
    process.env.SENDING_DKIM_TARGET = 'mmail._domainkey.maismail.com.br';
    sendingDomainService.lookupTxt = dns(DNS_OK);
  });

  afterEach(() => {
    process.env = { ...env };
    sendingDomainService.lookupTxt = lookupOriginal;
  });

  it('lista só os domínios que saem pelo servidor da plataforma, com os registros a criar', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    await criarSmtp(a.tenant._id, 'MAIL.maismail.com.br', 'contato@cliente.com.br', 'Marketing');
    await criarSmtp(a.tenant._id, 'smtp.sendgrid.net', 'news@outro.com.br');
    await criarSmtp(b.tenant._id, 'mail.maismail.com.br', 'segredo@cliente-b.com.br');

    const res = await request(app).get('/api/sending-domains').set(a.auth).expect(200);

    expect(res.body.enforced).toBe(true);
    expect(res.body.domains).toHaveLength(1);
    const [dominio] = res.body.domains;
    expect(dominio).toMatchObject({ domain: 'cliente.com.br', smtpNames: ['Marketing'], status: 'unverified' });
    expect(dominio.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'spf', value: 'v=spf1 include:maismail.com.br ~all' }),
        expect.objectContaining({
          check: 'dkim',
          type: 'CNAME',
          host: 'mmail._domainkey.cliente.com.br',
          value: 'mmail._domainkey.maismail.com.br',
        }),
      ])
    );
  });

  it('verificar grava o resultado e libera o domínio', async () => {
    const a = await criarCliente('Cliente A');
    await criarSmtp(a.tenant._id, 'mail.maismail.com.br', 'contato@cliente.com.br');

    const res = await request(app).post('/api/sending-domains/cliente.com.br/verify').set(a.auth).expect(200);
    expect(res.body.domain.status).toBe('verified');
    expect(res.body.domain.checks.spf.state).toBe('pass');

    const lista = await request(app).get('/api/sending-domains').set(a.auth).expect(200);
    expect(lista.body.domains[0].status).toBe('verified');
  });

  it('verificar mostra o que falta quando o DNS não está pronto', async () => {
    const a = await criarCliente('Cliente A');
    await criarSmtp(a.tenant._id, 'mail.maismail.com.br', 'contato@cliente.com.br');
    sendingDomainService.lookupTxt = dns(DNS_SO_GOOGLE);

    const res = await request(app).post('/api/sending-domains/cliente.com.br/verify').set(a.auth).expect(200);
    expect(res.body.domain.status).toBe('unverified');
    expect(res.body.domain.checks.spf.detail).toContain('include:maismail.com.br');
  });

  it('não verifica domínio que o cliente não usa, nem o de outro cliente', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    await criarSmtp(b.tenant._id, 'mail.maismail.com.br', 'contato@cliente-b.com.br');

    await request(app).post('/api/sending-domains/cliente-b.com.br/verify').set(a.auth).expect(404);
    await request(app).post('/api/sending-domains/nao%20e%20dominio/verify').set(a.auth).expect(400);
  });

  it('usuário comum não chega nos domínios', async () => {
    const comum = await criarCliente('Cliente A', 'user');
    await request(app).get('/api/sending-domains').set(comum.auth).expect(403);
  });

  it('bloqueia o disparo enquanto o DNS não autoriza o servidor', async () => {
    const a = await criarCliente('Cliente A');
    const smtp = await criarSmtp(a.tenant._id, 'mail.maismail.com.br', 'contato@cliente.com.br');
    const campanha = await criarCampanha(a.tenant._id, smtp._id);
    sendingDomainService.lookupTxt = dns(DNS_SO_GOOGLE);

    const res = await request(app).post(`/api/campaigns/${campanha._id}/start`).set(a.auth).send({}).expect(400);

    expect(res.body.code).toBe('DOMINIO_NAO_VERIFICADO');
    expect(res.body.error).toContain('cliente.com.br');
    expect(res.body.error).toContain('include:maismail.com.br');
    const depois = await runWithTenant(a.tenant._id, async () => Campaign.findById(campanha._id).lean());
    expect(depois?.status).toBe('draft');
  });

  it('com o DNS certo o disparo passa da trava', async () => {
    const a = await criarCliente('Cliente A');
    const smtp = await criarSmtp(a.tenant._id, 'mail.maismail.com.br', 'contato@cliente.com.br');
    const campanha = await criarCampanha(a.tenant._id, smtp._id);

    const res = await request(app).post(`/api/campaigns/${campanha._id}/start`).set(a.auth).send({});

    expect(res.body.code).not.toBe('DOMINIO_NAO_VERIFICADO');
  });

  it('servidor próprio do cliente não passa pela trava', async () => {
    const a = await criarCliente('Cliente A');
    const smtp = await criarSmtp(a.tenant._id, 'smtp.sendgrid.net', 'contato@cliente.com.br');
    const campanha = await criarCampanha(a.tenant._id, smtp._id);
    sendingDomainService.lookupTxt = dns({});

    const res = await request(app).post(`/api/campaigns/${campanha._id}/start`).set(a.auth).send({});

    expect(res.body.code).not.toBe('DOMINIO_NAO_VERIFICADO');
  });

  it('DNS fora do ar não derruba um domínio já liberado', async () => {
    const a = await criarCliente('Cliente A');
    const smtp = await criarSmtp(a.tenant._id, 'mail.maismail.com.br', 'contato@cliente.com.br');
    const campanha = await criarCampanha(a.tenant._id, smtp._id);
    await request(app).post('/api/sending-domains/cliente.com.br/verify').set(a.auth).expect(200);
    await runWithTenant(a.tenant._id, async () =>
      SendingDomain.updateOne({ domain: 'cliente.com.br' }, { checkedAt: new Date(Date.now() - 24 * 3600_000) })
    );
    sendingDomainService.lookupTxt = async () => {
      throw new DnsUnavailableError('ETIMEOUT');
    };

    const res = await request(app).post(`/api/campaigns/${campanha._id}/start`).set(a.auth).send({});

    expect(res.body.code).not.toBe('DOMINIO_NAO_VERIFICADO');
  });
});
