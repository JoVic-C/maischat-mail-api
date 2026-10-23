import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveMx = vi.fn();
const lookup = vi.fn();

vi.mock('node:dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => lookup(...args),
    Resolver: class {
      resolveMx = (...args: unknown[]) => resolveMx(...args);
    },
  },
}));

const { domainHasMail, emailDomainHasMail } = await import('../../utils/emailHygiene');

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('domainHasMail', () => {
  beforeEach(() => {
    resolveMx.mockReset();
    lookup.mockReset();
  });

  it('aceita domínio com MX', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx.empresa.com.br', priority: 10 }]);
    expect(await emailDomainHasMail('ana@empresa.com.br')).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('recusa domínio com MX nulo (RFC 7505)', async () => {
    resolveMx.mockResolvedValue([{ exchange: '', priority: 0 }]);
    expect(await emailDomainHasMail('ana@naorecebe.com')).toBe(false);
  });

  it('aceita domínio sem MX mas com endereço (MX implícito)', async () => {
    resolveMx.mockRejectedValue(dnsError('ENODATA'));
    lookup.mockResolvedValue({ address: '203.0.113.10', family: 4 });
    expect(await emailDomainHasMail('ana@so-a.com')).toBe(true);
  });

  it('recusa domínio inexistente', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));
    lookup.mockRejectedValue(dnsError('ENOTFOUND'));
    expect(await emailDomainHasMail('ana@dominio-que-nao-existe.com.br')).toBe(false);
  });

  it('na falha do nosso DNS não recusa o contato', async () => {
    resolveMx.mockRejectedValue(dnsError('ETIMEOUT'));
    lookup.mockRejectedValue(dnsError('EAI_AGAIN'));
    expect(await emailDomainHasMail('ana@empresa.com.br')).toBe(true);
  });

  it('com NXDOMAIN do MX, a falha transitória do lookup não salva o domínio', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));
    lookup.mockRejectedValue(dnsError('EAI_AGAIN'));
    expect(await emailDomainHasMail('ana@sumiu.com')).toBe(false);
  });

  it('lookup que não responde tem teto e não recusa o contato', async () => {
    vi.useFakeTimers();
    try {
      resolveMx.mockRejectedValue(dnsError('ECONNREFUSED'));
      lookup.mockReturnValue(new Promise(() => undefined));
      const resultado = emailDomainHasMail('ana@lento.com');
      await vi.advanceTimersByTimeAsync(3000);
      expect(await resultado).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('consulta cada domínio uma vez por cache', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx.x.com', priority: 10 }]);
    const cache = new Map<string, boolean>();
    await domainHasMail('X.com', cache);
    await domainHasMail('x.com', cache);
    expect(resolveMx).toHaveBeenCalledTimes(1);
  });
});
