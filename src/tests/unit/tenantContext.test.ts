import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { getTenantContext, requireTenantId, runAsSystem, runWithTenant } from '../../config/tenantContext';

/**
 * Este contexto é o substituto do Row Level Security: é ele que o plugin `tenantScope`
 * consulta para filtrar TODA query. Se ele vazar entre execuções, ou devolver escopo
 * onde não deveria, um cliente enxerga a base de outro — a falha mais grave possível
 * neste produto. Daí os testes cobrirem principalmente o que deve FALHAR.
 */
describe('contexto de cliente', () => {
  it('sem contexto ativo, exigir o cliente lança em vez de devolver vazio', () => {
    // O comportamento importa: devolver null aqui faria a query rodar SEM filtro.
    expect(() => requireTenantId()).toThrow(/contexto de tenant/i);
  });

  it('dentro do escopo, devolve o cliente como ObjectId', () => {
    const id = new Types.ObjectId();
    runWithTenant(id, () => {
      const atual = requireTenantId();
      expect(atual).toBeInstanceOf(Types.ObjectId);
      expect(String(atual)).toBe(String(id));
    });
  });

  it('aceita o cliente como string e normaliza para ObjectId', () => {
    // O superadmin opera via header X-Tenant-Id, que chega como string. Sem normalizar,
    // o filtro nunca casa com o campo ObjectId e a query devolve VAZIO em silêncio.
    const id = new Types.ObjectId().toString();
    runWithTenant(id, () => {
      expect(requireTenantId()).toBeInstanceOf(Types.ObjectId);
    });
  });

  it('recusa um identificador inválido em vez de abrir escopo quebrado', () => {
    expect(() => runWithTenant('nao-e-um-id', () => null)).toThrow(/tenantId inválido/i);
  });

  it('o escopo não vaza para fora da função', () => {
    runWithTenant(new Types.ObjectId(), () => undefined);
    expect(() => requireTenantId()).toThrow();
  });

  it('escopos aninhados não se misturam: o de dentro vale e o de fora volta ao fim', () => {
    const externo = new Types.ObjectId();
    const interno = new Types.ObjectId();
    runWithTenant(externo, () => {
      runWithTenant(interno, () => {
        expect(String(requireTenantId())).toBe(String(interno));
      });
      expect(String(requireTenantId())).toBe(String(externo));
    });
  });

  it('modo system devolve cliente nulo, mas COM contexto ativo', () => {
    // A diferença importa: nulo com contexto = "sem filtro, de propósito";
    // ausência de contexto = "alguém esqueceu de abrir o escopo".
    runAsSystem(() => {
      expect(requireTenantId()).toBeNull();
      expect(getTenantContext()?.mode).toBe('system');
    });
  });

  it('o escopo sobrevive ao await dentro da função', async () => {
    const id = new Types.ObjectId();
    await runWithTenant(id, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(String(requireTenantId())).toBe(String(id));
    });
  });
});
