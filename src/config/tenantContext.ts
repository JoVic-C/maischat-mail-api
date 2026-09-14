/**
 * Contexto do cliente da requisição ou job em execução.
 *
 * O Mongo não tem Row Level Security; o equivalente é este AsyncLocalStorage somado ao
 * plugin `tenantScope`, que injeta o `tenantId` em toda query e escrita.
 *
 * - tenant  → só enxerga os dados daquele cliente
 * - system  → sem escopo, para o que não tem cliente na entrada (tracking, webhook, scripts)
 * - ausente → o plugin recusa qualquer query
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Types } from 'mongoose';

export interface TenantContext {
  /** null no modo 'system'; sempre ObjectId no modo 'tenant'. */
  tenantId: Types.ObjectId | null;
  mode: 'tenant' | 'system';
}

/**
 * O hook do `tenantScope` injeta o valor depois do cast da query, e `.cursor()` não casta
 * o que foi acrescentado. Com string, o filtro nunca casa e o cursor volta vazio, sem erro.
 */
function normalizeTenantId(tenantId: Types.ObjectId | string): Types.ObjectId {
  if (tenantId instanceof Types.ObjectId) return tenantId;
  if (!Types.ObjectId.isValid(tenantId)) {
    throw new Error(`tenantId inválido: ${String(tenantId)}`);
  }
  return new Types.ObjectId(String(tenantId));
}

const storage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * O `await` tem que ficar dentro de `fn`: uma Query do Mongoose só executa quando
 * aguardada. Use `async () => await Model.find()`, não `() => Model.find()`.
 */
export function runWithTenant<T>(tenantId: Types.ObjectId | string, fn: () => T): T {
  return storage.run({ tenantId: normalizeTenantId(tenantId), mode: 'tenant' }, fn);
}

/**
 * Reentra num contexto já capturado. Necessário para middleware dirigido por eventos do
 * stream `req` (o multer): o AsyncLocalStorage amarra o contexto à criação do recurso, e
 * o `req` nasce antes de o escopo do cliente existir.
 */
export function runInContext<T>(ctx: TenantContext | undefined, fn: () => T): T {
  if (!ctx) return fn();
  return storage.run(ctx, fn);
}

/** Sem escopo de cliente. Nunca use para atender uma rota autenticada. */
export function runAsSystem<T>(fn: () => T): T {
  return storage.run({ tenantId: null, mode: 'system' }, fn);
}

export function requireTenantId(): Types.ObjectId | null {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'Nenhum contexto de tenant ativo. Rotas autenticadas devem passar pelo middleware ' +
        'tenantContext; jobs e scripts devem usar runWithTenant() ou runAsSystem().'
    );
  }
  return ctx.tenantId;
}
