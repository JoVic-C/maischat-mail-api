import type { Request, RequestHandler, Response } from 'express';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { getTenantContext, runWithTenant } from '../../config/tenantContext';
import { comLimiteNaMensagem } from '../../middleware/upload';

// O multer segue eventos do `req`, criado antes do escopo do cliente; em upload grande o callback roda fora dele.
// O handler falso força isso chamando o callback só DEPOIS que o escopo fechou, sem depender do tamanho do arquivo.
describe('contexto do cliente através do upload', () => {
  const tenantId = new Types.ObjectId();
  const req = {} as Request;
  const res = {} as Response;

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
