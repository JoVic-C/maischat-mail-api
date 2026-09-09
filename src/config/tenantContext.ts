/**
 * Contexto de tenant da requisição/job em execução.
 *
 * O Mongo não tem Row Level Security. O equivalente aqui é este contexto
 * (AsyncLocalStorage) + o plugin `tenantScope`: o `tenantId` é injetado
 * automaticamente em TODA query e TODA escrita, sem depender de o service
 * lembrar de filtrar. Esquecer o filtro deixa de ser um vazamento de dados.
 *
 * Três modos:
 * - tenant  → escopo normal: só enxerga os dados daquele cliente.
 * - system  → sem escopo, para o que legitimamente não tem tenant na entrada
 *             (tracking público, webhook, scripts). Use com intenção explícita.
 * - ausente → nenhuma query com o plugin pode rodar; o plugin lança erro.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Types } from 'mongoose';

export interface TenantContext {
  /** null quando o modo é 'system'. Sempre ObjectId no modo 'tenant' — ver normalizeTenantId. */
  tenantId: Types.ObjectId | null;
  mode: 'tenant' | 'system';
}

/**
 * Converte o tenant para ObjectId antes de entrar no contexto.
 *
 * Não é preciosismo de tipo: o hook do `tenantScope` injeta este valor no filtro
 * DEPOIS de o Mongoose ter feito o cast da query, e o caminho de `.cursor()` não casta
 * o que o hook acrescenta. Com uma string, o filtro `tenantId` nunca casa com o campo
 * ObjectId e o cursor devolve VAZIO — sem erro, sem aviso. Era o que acontecia quando o
 * superadmin operava via header `X-Tenant-Id` (uma string): o disparo de campanha, que
 * percorre destinatários por cursor, enfileirava zero envios e deixava a campanha presa
 * em 'sending' para sempre.
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
 * Executa `fn` no escopo de um cliente. Tudo que rodar dentro fica filtrado por ele.
 *
 * ⚠️ O `await` tem que estar DENTRO de `fn`. Uma Query do Mongoose só executa quando
 * é aguardada, então `runWithTenant(id, () => Model.find())` devolve a query e o
 * contexto já terá sido fechado quando ela rodar. Use `async () => await Model.find()`.
 */
export function runWithTenant<T>(tenantId: Types.ObjectId | string, fn: () => T): T {
  return storage.run({ tenantId: normalizeTenantId(tenantId), mode: 'tenant' }, fn);
}

/**
 * Reexecuta `fn` dentro de um contexto já capturado.
 *
 * Existe para atravessar middleware que trabalha por eventos do stream `req` — o
 * multer, no upload de arquivo. O AsyncLocalStorage prende o contexto ao momento em
 * que o recurso assíncrono é CRIADO, e o `req` nasce quando a conexão chega, antes de
 * o tenantContext abrir o escopo. Resultado: quando o upload termina e o callback do
 * multer dispara, não há cliente ativo, e a primeira query depois disso é recusada
 * pelo tenantScope — com um erro que parece defeito de servidor.
 *
 * Só restaura o que já existia: sem contexto capturado, não inventa nenhum.
 */
export function runInContext<T>(ctx: TenantContext | undefined, fn: () => T): T {
  if (!ctx) return fn();
  return storage.run(ctx, fn);
}

/**
 * Executa `fn` SEM escopo de tenant. Reservado para fluxos que não têm um cliente
 * na entrada e cujo controle de acesso é outro (assinatura HMAC, token de webhook,
 * execução manual de script). Nunca use para atender uma rota autenticada.
 */
export function runAsSystem<T>(fn: () => T): T {
  return storage.run({ tenantId: null, mode: 'system' }, fn);
}

/** O tenant atual, ou null no modo system. Lança se não houver contexto algum. */
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
