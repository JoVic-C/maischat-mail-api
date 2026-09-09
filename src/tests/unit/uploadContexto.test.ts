import type { Request, RequestHandler, Response } from 'express';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { getTenantContext, runWithTenant } from '../../config/tenantContext';
import { comLimiteNaMensagem } from '../../middleware/upload';

/**
 * O contexto do cliente tem que sobreviver ao upload.
 *
 * O multer é dirigido por eventos do stream `req`, criado quando a conexão chega —
 * antes de o tenantContext abrir o escopo. Como o AsyncLocalStorage amarra o contexto
 * ao momento de criação do recurso assíncrono, o callback do upload podia rodar sem
 * cliente ativo, e a primeira query depois disso morria em "Query em modelo
 * multi-tenant sem contexto ativo" — um 500 que parecia defeito do servidor.
 *
 * Em arquivo pequeno o upload termina ainda dentro do escopo e nada acusa; com 1,4 MB,
 * o término cai fora. Por isso o teste força o cenário em vez de depender do tamanho:
 * o handler falso guarda o callback e só o chama DEPOIS que o escopo fechou.
 */
describe('contexto do cliente através do upload', () => {
  const tenantId = new Types.ObjectId();
  const req = {} as Request;
  const res = {} as Response;

  /** Imita o multer: recebe o controle, devolve na mão de quem chamar `terminar`. */
  function multerFalso(): { handler: RequestHandler; terminar: (err?: unknown) => void } {
    let pendente: ((err?: unknown) => void) | undefined;
    return {
      handler: (_req, _res, next) => {
        pendente = next as (err?: unknown) => void;
      },
      terminar: (err?: unknown) => pendente?.(err),
    };
  }

  it('o cliente continua ativo quando o upload termina fora do escopo', () => {
    const { handler, terminar } = multerFalso();
    const envolvido = comLimiteNaMensagem(handler, 100);

    let contextoNoNext: ReturnType<typeof getTenantContext>;
    runWithTenant(tenantId, () => {
      envolvido(req, res, () => {
        contextoNoNext = getTenantContext();
      });
    });

    // Aqui o `runWithTenant` já retornou: é exatamente onde o multer devolvia o
    // controle num upload grande.
    expect(getTenantContext()).toBeUndefined();
    terminar();

    expect(contextoNoNext?.tenantId?.toString()).toBe(tenantId.toString());
    expect(contextoNoNext?.mode).toBe('tenant');
  });

  it('vale também quando o upload termina em erro', () => {
    const { handler, terminar } = multerFalso();
    const envolvido = comLimiteNaMensagem(handler, 100);

    let contextoNoNext: ReturnType<typeof getTenantContext>;
    let recebido: unknown;
    runWithTenant(tenantId, () => {
      envolvido(req, res, (err?: unknown) => {
        contextoNoNext = getTenantContext();
        recebido = err;
      });
    });

    const falha = new Error('falha no upload');
    terminar(falha);

    // O tratamento do erro também precisa do cliente: é ele que decide o que limpar.
    expect(contextoNoNext?.tenantId?.toString()).toBe(tenantId.toString());
    expect(recebido).toBe(falha);
  });

  it('sem contexto na entrada, não inventa nenhum', () => {
    // Upload de imagem/anexo pode rodar em rota sem escopo de cliente.
    const { handler, terminar } = multerFalso();
    const envolvido = comLimiteNaMensagem(handler, 5);

    let chamou = false;
    let contextoNoNext: ReturnType<typeof getTenantContext> = { tenantId: null, mode: 'system' };
    envolvido(req, res, () => {
      chamou = true;
      contextoNoNext = getTenantContext();
    });
    terminar();

    expect(chamou).toBe(true);
    expect(contextoNoNext).toBeUndefined();
  });
});
