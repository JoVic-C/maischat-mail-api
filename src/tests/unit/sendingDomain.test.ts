import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DnsUnavailableError, domainOf, evaluateDomain, type TxtLookup } from '../../services/sendingDomain.service';

const CHAVE = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtesteChave';

function dns(records: Record<string, string[]>): TxtLookup {
  return async (name) => records[name] ?? [];
}

const GOOGLE_E_PLATAFORMA: Record<string, string[]> = {
  'cliente.com.br': ['v=spf1 include:_spf.google.com include:maismail.com.br ~all', 'google-site-verification=abc'],
  'mmail._domainkey.cliente.com.br': [`v=DKIM1; k=rsa; p=${CHAVE}`],
  'google._domainkey.cliente.com.br': ['v=DKIM1; k=rsa; p=OUTRACHAVE'],
  'mmail._domainkey.maismail.com.br': [`v=DKIM1; k=rsa; p=${CHAVE}`],
  '_dmarc.cliente.com.br': ['v=DMARC1; p=quarantine; rua=mailto:dmarc@cliente.com.br'],
};

describe('verificação do domínio de envio', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.SENDING_SPF_INCLUDE = 'maismail.com.br';
    process.env.SENDING_DKIM_SELECTOR = 'mmail';
    process.env.SENDING_DKIM_TARGET = 'mmail._domainkey.maismail.com.br';
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('libera o domínio que usa Google Workspace e autoriza a plataforma', async () => {
    const checks = await evaluateDomain('cliente.com.br', dns(GOOGLE_E_PLATAFORMA));
    expect(checks.spf.state).toBe('pass');
    expect(checks.dkim.state).toBe('pass');
    expect(checks.dmarc).toEqual({ state: 'pass', detail: 'DMARC publicado, com política quarantine.' });
  });

  it('SPF só com o Google não autoriza o servidor de envio', async () => {
    const checks = await evaluateDomain(
      'cliente.com.br',
      dns({ ...GOOGLE_E_PLATAFORMA, 'cliente.com.br': ['v=spf1 include:_spf.google.com ~all'] })
    );
    expect(checks.spf.state).toBe('fail');
    expect(checks.spf.detail).toContain('include:maismail.com.br');
  });

  it('dois registros SPF invalidam os dois', async () => {
    const checks = await evaluateDomain(
      'cliente.com.br',
      dns({
        ...GOOGLE_E_PLATAFORMA,
        'cliente.com.br': ['v=spf1 include:_spf.google.com ~all', 'v=spf1 include:maismail.com.br ~all'],
      })
    );
    expect(checks.spf).toMatchObject({ state: 'fail' });
    expect(checks.spf.detail).toMatch(/2 registros SPF/);
  });

  it('não confunde um include parecido com o da plataforma', async () => {
    const checks = await evaluateDomain(
      'cliente.com.br',
      dns({ ...GOOGLE_E_PLATAFORMA, 'cliente.com.br': ['v=spf1 include:maismail.com.br.golpe.io ~all'] })
    );
    expect(checks.spf.state).toBe('fail');
  });

  it('a chave do Google no próprio seletor não conta como a do servidor de envio', async () => {
    const semChave = { ...GOOGLE_E_PLATAFORMA };
    delete semChave['mmail._domainkey.cliente.com.br'];
    expect((await evaluateDomain('cliente.com.br', dns(semChave))).dkim.state).toBe('fail');
  });

  it('recusa uma chave DKIM diferente da publicada pela plataforma', async () => {
    const checks = await evaluateDomain(
      'cliente.com.br',
      dns({ ...GOOGLE_E_PLATAFORMA, 'mmail._domainkey.cliente.com.br': ['v=DKIM1; k=rsa; p=CHAVEDEOUTRO'] })
    );
    expect(checks.dkim.detail).toMatch(/não é a do servidor/);
  });

  it('chave DKIM vazia é revogada', async () => {
    const checks = await evaluateDomain(
      'cliente.com.br',
      dns({ ...GOOGLE_E_PLATAFORMA, 'mmail._domainkey.cliente.com.br': ['v=DKIM1; p='] })
    );
    expect(checks.dkim.detail).toMatch(/revogada/);
  });

  it('sem DMARC o domínio não passa', async () => {
    const semDmarc = { ...GOOGLE_E_PLATAFORMA };
    delete semDmarc['_dmarc.cliente.com.br'];
    expect((await evaluateDomain('cliente.com.br', dns(semDmarc))).dmarc.state).toBe('fail');
  });

  it('sem SENDING_DKIM_TARGET basta existir uma chave no seletor', async () => {
    process.env.SENDING_DKIM_TARGET = '';
    const checks = await evaluateDomain(
      'cliente.com.br',
      dns({ ...GOOGLE_E_PLATAFORMA, 'mmail._domainkey.cliente.com.br': ['v=DKIM1; k=rsa; p=QUALQUER'] })
    );
    expect(checks.dkim.state).toBe('pass');
  });

  it('DNS indisponível vira "error", não reprovação', async () => {
    const lookup: TxtLookup = async () => {
      throw new DnsUnavailableError('ETIMEOUT');
    };
    const checks = await evaluateDomain('cliente.com.br', lookup);
    expect([checks.spf.state, checks.dkim.state, checks.dmarc.state]).toEqual(['error', 'error', 'error']);
  });

  it('chave de referência ausente é problema da plataforma, não do cliente', async () => {
    const semReferencia = { ...GOOGLE_E_PLATAFORMA };
    delete semReferencia['mmail._domainkey.maismail.com.br'];
    expect((await evaluateDomain('cliente.com.br', dns(semReferencia))).dkim.state).toBe('error');
  });

  it('extrai o domínio do remetente', () => {
    expect(domainOf('Contato@Cliente.com.br')).toBe('cliente.com.br');
    expect(domainOf('sem-arroba')).toBe('');
  });
});
