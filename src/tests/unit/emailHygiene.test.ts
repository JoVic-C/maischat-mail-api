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

const { dnsAcceptsMail, domainOf } = await import('../../utils/emailHygiene');

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('dnsAcceptsMail', () => {
  beforeEach(() => {
    resolveMx.mockReset();
    lookup.mockReset();
  });

  it('aceita domínio com MX', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx.empresa.com.br', priority: 10 }]);
    expect(await dnsAcceptsMail('empresa.com.br')).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('recusa domínio com MX nulo (RFC 7505)', async () => {
    resolveMx.mockResolvedValue([{ exchange: '', priority: 0 }]);
    expect(await dnsAcceptsMail('naorecebe.com')).toBe(false);
  });

  it('aceita domínio sem MX mas com endereço (MX implícito)', async () => {
    resolveMx.mockRejectedValue(dnsError('ENODATA'));
    lookup.mockResolvedValue({ address: '203.0.113.10', family: 4 });
    expect(await dnsAcceptsMail('so-a.com')).toBe(true);
  });

  it('recusa domínio inexistente', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));
    lookup.mockRejectedValue(dnsError('ENOTFOUND'));
    expect(await dnsAcceptsMail('dominio-que-nao-existe.com.br')).toBe(false);
  });

  it('na falha do nosso DNS não recusa o contato', async () => {
    resolveMx.mockRejectedValue(dnsError('ETIMEOUT'));
    lookup.mockRejectedValue(dnsError('EAI_AGAIN'));
    expect(await dnsAcceptsMail('empresa.com.br')).toBe(true);
  });

  it('com NXDOMAIN do MX, a falha transitória do lookup não salva o domínio', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));
    lookup.mockRejectedValue(dnsError('EAI_AGAIN'));
    expect(await dnsAcceptsMail('sumiu.com')).toBe(false);
  });

  it('lookup que não responde tem teto e não recusa o contato', async () => {
    vi.useFakeTimers();
    try {
      resolveMx.mockRejectedValue(dnsError('ECONNREFUSED'));
      lookup.mockReturnValue(new Promise(() => undefined));
      const resultado = dnsAcceptsMail('lento.com');
      await vi.advanceTimersByTimeAsync(3000);
      expect(await resultado).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('domainOf', () => {
  it('extrai o domínio em minúsculas, sem ponto final', () => {
    expect(domainOf('Ana@Empresa.COM.br.')).toBe('empresa.com.br');
    expect(domainOf('sem-arroba')).toBe('');
  });
});
