/**
 * Isolamento por cliente, no lugar do Row Level Security do Postgres. Adiciona `tenantId`
 * ao schema e o injeta em toda query, criação e agregação. No modo `system` não filtra.
 */
import type { Aggregate, Query, Schema } from 'mongoose';
import { getTenantContext } from '../../config/tenantContext';

const QUERY_HOOKS =
  /^(count|countDocuments|deleteMany|deleteOne|distinct|find|findOne|findOneAndDelete|findOneAndReplace|findOneAndUpdate|replaceOne|updateMany|updateOne)$/;

function currentScope(): { scoped: boolean; tenantId: unknown } {
  const ctx = getTenantContext();
  if (!ctx) {
    throw new Error(
      'Query em modelo multi-tenant sem contexto ativo. Use o middleware tenantContext, ' +
        'runWithTenant() ou runAsSystem().'
    );
  }
  return { scoped: ctx.mode === 'tenant', tenantId: ctx.tenantId };
}

interface TenantDoc {
  tenantId?: unknown;
  isNew: boolean;
  isModified(path: string): boolean;
}

const REPLACE_OPS = new Set(['replaceOne', 'findOneAndReplace']);

/**
 * Um update no modo cliente não troca o dono: o filtro já fixa o tenantId, e um `$set`
 * dele moveria o documento para outro cliente. Numa substituição o documento novo herda
 * o dono do contexto, senão perderia o tenantId.
 */
function pinTenantInUpdate(query: Query<unknown, unknown>, tenantId: unknown): void {
  const update = query.getUpdate() as Record<string, unknown> | null;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return;
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith('$') && value && typeof value === 'object') {
      delete (value as Record<string, unknown>).tenantId;
    }
  }
  // `op` existe em runtime (o nome da operação), mas a tipagem do Mongoose não o expõe.
  const op = (query as unknown as { op?: string }).op ?? '';
  if (REPLACE_OPS.has(op) || 'tenantId' in update) update.tenantId = tenantId;
}

/** Usado pela checagem de índices do boot para saber quais collections são por cliente. */
const escopados = new Set<Schema>();

export function isTenantScoped(schema: Schema): boolean {
  return escopados.has(schema);
}

export function tenantScope(schema: Schema): void {
  escopados.add(schema);

  schema.add({
    tenantId: {
      type: 'ObjectId',
      ref: 'Tenant',
      required: true,
      index: true,
    },
  });

  schema.pre(QUERY_HOOKS, function (this: Query<unknown, unknown>) {
    const { scoped, tenantId } = currentScope();
    if (!scoped) return;
    this.where({ tenantId });
    pinTenantInUpdate(this, tenantId);
  });

  // Em 'validate', não em 'save': o pre('save') de plugin roda depois da validação, e o
  // campo obrigatório já teria falhado. No modo cliente o dono é SEMPRE o do contexto: um
  // tenantId vindo do corpo da requisição nunca decide de quem é o documento.
  schema.pre('validate', function (this: TenantDoc) {
    const { scoped, tenantId } = currentScope();
    if (!scoped) return;
    if (this.isNew) {
      this.tenantId = tenantId;
    } else if (this.isModified('tenantId') && String(this.tenantId) !== String(tenantId)) {
      throw new Error('Não é permitido mover um documento para outro cliente.');
    }
  });

  // Este hook recebe `next` e o Mongoose espera a chamada; sem ela o insertMany trava.
  schema.pre('insertMany', (next, docs: Record<string, unknown>[]) => {
    try {
      const { scoped, tenantId } = currentScope();
      if (scoped && Array.isArray(docs)) {
        for (const doc of docs) doc.tenantId = tenantId;
      }
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  schema.pre('aggregate', function (this: Aggregate<unknown[]>) {
    const { scoped, tenantId } = currentScope();
    if (!scoped) return;
    this.pipeline().unshift({ $match: { tenantId } });
  });
}
