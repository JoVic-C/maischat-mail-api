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
  });

  // Em 'validate', não em 'save': o pre('save') de plugin roda depois da validação, e o
  // campo obrigatório já teria falhado.
  schema.pre('validate', function (this: { tenantId?: unknown; isNew: boolean }) {
    const { scoped, tenantId } = currentScope();
    if (!scoped) return;
    if (this.isNew && !this.tenantId) this.tenantId = tenantId;
  });

  // Este hook recebe `next` e o Mongoose espera a chamada; sem ela o insertMany trava.
  schema.pre('insertMany', (next, docs: Record<string, unknown>[]) => {
    try {
      const { scoped, tenantId } = currentScope();
      if (scoped && Array.isArray(docs)) {
        for (const doc of docs) {
          if (!doc.tenantId) doc.tenantId = tenantId;
        }
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
