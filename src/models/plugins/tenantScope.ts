/**
 * Plugin de isolamento por cliente (multi-tenancy).
 *
 * Aplicado a um schema, ele:
 *  1. adiciona o campo `tenantId` (obrigatório e indexado);
 *  2. injeta `tenantId` no filtro de TODA leitura/escrita por query;
 *  3. preenche `tenantId` em TODA criação (save, insertMany);
 *  4. prefixa `$match` em toda agregação.
 *
 * É o substituto do Row Level Security do Postgres: mesmo que um service esqueça
 * o filtro, a query sai escopada. No modo `system` (tracking público, webhook,
 * scripts) o plugin não filtra — ver `config/tenantContext`.
 */
import type { Aggregate, Query, Schema } from 'mongoose';
import { getTenantContext } from '../../config/tenantContext';

/**
 * Operações de query que precisam do filtro por tenant.
 * Regex porque o `schema.pre` aceita um padrão único para todas elas.
 */
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

/**
 * Schemas que receberam o plugin. Serve para a checagem de índices no boot saber
 * QUAIS collections precisam ter unicidade por cliente — um modelo novo que use o
 * plugin entra na verificação sozinho, sem lista para manter em outro arquivo.
 */
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
    // O escopo do contexto sempre prevalece: um filtro do service pode restringir
    // mais, nunca ampliar para outro cliente.
    this.where({ tenantId });
  });

  // Em 'validate', não em 'save': o hook interno de validação do Mongoose é
  // registrado antes dos hooks de plugin, então um pre('save') aqui rodaria
  // DEPOIS da validação e o campo obrigatório já teria falhado.
  schema.pre('validate', function (this: { tenantId?: unknown; isNew: boolean }) {
    const { scoped, tenantId } = currentScope();
    if (!scoped) return; // modo system: quem cria informa o tenantId à mão
    if (this.isNew && !this.tenantId) this.tenantId = tenantId;
  });

  // Este hook recebe `next` e o Mongoose ESPERA a chamada dele: sem isso o
  // insertMany fica pendurado para sempre.
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
