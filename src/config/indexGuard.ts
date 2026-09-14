import mongoose from 'mongoose';
import { isTenantScoped } from '../models/plugins/tenantScope';
import { logger } from '../utils/logger';
import { captureError } from './sentry';

/**
 * Checagem de índices no boot. O Mongoose cria os índices do schema mas nunca remove os
 * antigos: um índice único anterior ao multi-cliente (ex.: `contacts.email`) impediria
 * dois clientes de terem o mesmo registro. Só avisa; nunca derruba a API.
 */

export interface IndexIssue {
  collection: string;
  index: string;
  key: Record<string, unknown>;
}

/**
 * Índice único que começa por referência a outra entidade do cliente também é seguro
 * (ex.: `SendLog.{campaignId, contactId}`). Segue o `ref` do schema para não gerar
 * alarme falso em modelos novos com o mesmo desenho.
 */
function apontaParaEntidadeDoCliente(schema: mongoose.Schema, caminho: string): boolean {
  const ref = schema.path(caminho)?.options?.ref;
  if (typeof ref !== 'string') return false;
  const referenciado = mongoose.models[ref];
  return Boolean(referenciado && isTenantScoped(referenciado.schema));
}

/** Índices únicos que não começam por `tenantId`, só nas collections com o plugin tenantScope. */
export async function findGlobalUniqueIndexes(): Promise<IndexIssue[]> {
  const issues: IndexIssue[] = [];

  for (const model of Object.values(mongoose.models)) {
    if (!isTenantScoped(model.schema)) continue;

    let indexes: Awaited<ReturnType<typeof model.collection.indexes>>;
    try {
      indexes = await model.collection.indexes();
    } catch {
      continue; // collection ainda não existe
    }

    for (const index of indexes) {
      if (!index.unique || index.name === '_id_') continue;
      const primeiraChave = Object.keys(index.key)[0];
      if (primeiraChave === 'tenantId') continue;
      if (apontaParaEntidadeDoCliente(model.schema, primeiraChave)) continue;

      issues.push({
        collection: model.collection.collectionName,
        index: String(index.name),
        key: index.key as Record<string, unknown>,
      });
    }
  }

  return issues;
}

export async function verifyTenantIndexes(): Promise<IndexIssue[]> {
  let issues: IndexIssue[] = [];
  try {
    issues = await findGlobalUniqueIndexes();
  } catch (err) {
    logger.warn('Não foi possível verificar os índices por cliente', { message: (err as Error).message });
    return [];
  }

  if (!issues.length) return [];

  for (const i of issues) {
    logger.error(
      `⚠️  Índice único GLOBAL em collection por cliente: ${i.collection}.${i.index} ${JSON.stringify(i.key)} — ` +
        'dois clientes não conseguirão ter o mesmo registro. Remova o índice legado ' +
        '(npm run migrate:multi-tenant) depois de conferir que existe o equivalente por tenantId.'
    );
  }

  captureError(new Error(`Índices únicos globais em collections multi-cliente: ${issues.length}`), {
    scope: 'indexGuard',
    issues,
  });

  return issues;
}
