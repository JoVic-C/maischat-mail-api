import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Redis em memória com o mínimo que o serviço usa; `failing` simula o Redis fora do ar. */
const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  const state = { failing: false };
  const guard = () => {
    if (state.failing) throw new Error('Redis fora');
  };
  return {
    store,
    state,
    client: {
      get: async (key: string) => {
        guard();
        return store.get(key) ?? null;
      },
      set: async (key: string, value: string) => {
        guard();
        store.set(key, value);
        return 'OK';
      },
      incr: async (key: string) => {
        guard();
        const n = Number(store.get(key) ?? 0) + 1;
        store.set(key, String(n));
        return n;
      },
      decr: async (key: string) => {
        guard();
        const n = Number(store.get(key) ?? 0) - 1;
        store.set(key, String(n));
        return n;
      },
      expire: async () => {
        guard();
        return 1;
      },
    },
  };
});

const dnsAcceptsMail = vi.hoisted(() => vi.fn<(domain: string) => Promise<boolean>>());
const checkDisposable = vi.hoisted(() => vi.fn<(domain: string) => Promise<{ result: string; mxServer: null }>>());
const provider = vi.hoisted(() => ({ configured: true }));

vi.mock('../../config/redis', () => ({ redisConnection: redis.client }));
vi.mock('../../config/sentry', () => ({ captureError: vi.fn() }));
vi.mock('../../utils/emailHygiene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/emailHygiene')>()),
  dnsAcceptsMail,
}));
vi.mock('../../services/emailListVerify.client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/emailListVerify.client')>();
  return {
    ...original,
    default: {
      get configured() {
        return provider.configured;
      },
      checkDisposable,
    },
  };
});

const { DomainCheckService } = await import('../../services/domainCheck.service');
const { EmailVerifyProviderError } = await import('../../services/emailListVerify.client');

function respostaDoProvedor(result: string) {
  return { result, mxServer: null };
}

describe('checagem de domínio', () => {
  let service: InstanceType<typeof DomainCheckService>;

  beforeEach(() => {
    service = new DomainCheckService();
    redis.store.clear();
    redis.state.failing = false;
    provider.configured = true;
    dnsAcceptsMail.mockReset().mockResolvedValue(true);
    checkDisposable.mockReset().mockResolvedValue(respostaDoProvedor('ok'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('domínio sem DNS é recusado sem gastar crédito', async () => {
    dnsAcceptsMail.mockResolvedValue(false);
    expect(await service.check('nao-existe.com.br')).toBe('no-mail');
    expect(checkDisposable).not.toHaveBeenCalled();
  });

  it.each([
    ['ok', 'ok'],
    ['disposable', 'disposable'],
    ['dead_server', 'no-mail'],
    ['invalid_mx', 'no-mail'],
  ])('resultado %s do provedor vira %s', async (resultado, veredito) => {
    checkDisposable.mockResolvedValue(respostaDoProvedor(resultado));
    expect(await service.check('dominio.com')).toBe(veredito);
  });

  it('guarda o veredito: o mesmo domínio não volta ao provedor', async () => {
    checkDisposable.mockResolvedValue(respostaDoProvedor('disposable'));
    await service.check('mailinator.com');
    expect(await service.check('MAILINATOR.com.')).toBe('disposable');
    expect(checkDisposable).toHaveBeenCalledTimes(1);
    expect(dnsAcceptsMail).toHaveBeenCalledTimes(1);
  });

  it('consultas simultâneas ao mesmo domínio viram uma só', async () => {
    const vereditos = await Promise.all([service.check('gmail.com'), service.check('gmail.com')]);
    expect(vereditos).toEqual(['ok', 'ok']);
    expect(checkDisposable).toHaveBeenCalledTimes(1);
  });

  it('resultado inconclusivo aprova pelo DNS e não entra no cache', async () => {
    checkDisposable.mockResolvedValue(respostaDoProvedor('unknown'));
    expect(await service.check('incerto.com')).toBe('ok');
    await service.check('incerto.com');
    expect(checkDisposable).toHaveBeenCalledTimes(2);
  });

  it('provedor fora do ar não reprova o domínio', async () => {
    checkDisposable.mockRejectedValue(new EmailVerifyProviderError('fora', 'unavailable'));
    expect(await service.check('empresa.com.br')).toBe('ok');
    expect([...redis.store.keys()].some((k) => k.startsWith('domain-check:v1:'))).toBe(false);
  });

  it('sem créditos não reprova o domínio e devolve a consulta ao teto diário', async () => {
    checkDisposable.mockRejectedValue(new EmailVerifyProviderError('Sem créditos', 'credit'));
    expect(await service.check('empresa.com.br')).toBe('ok');
    const diario = [...redis.store.entries()].find(([k]) => k.startsWith('domain-check:daily:'));
    expect(diario?.[1]).toBe('0');
  });

  it('desligado por variável, só o DNS decide', async () => {
    vi.stubEnv('DOMAIN_CHECK_ENABLED', 'false');
    expect(await service.check('mailinator.com')).toBe('ok');
    expect(checkDisposable).not.toHaveBeenCalled();
  });

  it('sem chave da EmailListVerify, só o DNS decide', async () => {
    provider.configured = false;
    expect(await service.check('mailinator.com')).toBe('ok');
    expect(checkDisposable).not.toHaveBeenCalled();
  });

  it('aprovado só pelo DNS não vai para o cache (ligar o provedor depois tem efeito)', async () => {
    provider.configured = false;
    await service.check('empresa.com.br');
    provider.configured = true;
    checkDisposable.mockResolvedValue(respostaDoProvedor('dead_server'));
    expect(await service.check('empresa.com.br')).toBe('no-mail');
  });

  it('acima do teto diário, segue só com o DNS', async () => {
    vi.stubEnv('DOMAIN_CHECK_DAILY_LIMIT', '1');
    await service.check('primeiro.com');
    expect(await service.check('segundo.com')).toBe('ok');
    expect(checkDisposable).toHaveBeenCalledTimes(1);
  });

  it('sem vaga no limite por segundo e sem espera, segue só com o DNS', async () => {
    vi.stubEnv('DOMAIN_CHECK_RATE_PER_SEC', '1');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-12T10:00:00.100Z'));
      await service.check('primeiro.com');
      expect(await service.check('segundo.com')).toBe('ok');
      expect(checkDisposable).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('com espera, aguarda a próxima janela do limite por segundo', async () => {
    vi.stubEnv('DOMAIN_CHECK_RATE_PER_SEC', '1');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-12T10:00:00.100Z'));
      await service.check('primeiro.com');
      checkDisposable.mockResolvedValue(respostaDoProvedor('disposable'));
      const segundo = service.check('segundo.com', { waitForSlotMs: 2000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await segundo).toBe('disposable');
      expect(checkDisposable).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('com o Redis fora, ainda decide pelo DNS sem travar', async () => {
    redis.state.failing = true;
    expect(await service.check('empresa.com.br')).toBe('ok');
    dnsAcceptsMail.mockResolvedValue(false);
    expect(await service.check('sumiu.com')).toBe('no-mail');
    expect(checkDisposable).not.toHaveBeenCalled();
  });

  it('domínio vazio ou longo demais é recusado', async () => {
    expect(await service.checkEmail('sem-arroba')).toBe('no-mail');
    expect(await service.check(`${'a'.repeat(256)}.com`)).toBe('no-mail');
    expect(dnsAcceptsMail).not.toHaveBeenCalled();
  });
});
