import mongoose from 'mongoose';
import { isTenantScoped } from '../models/plugins/tenantScope';
import { logger } from '../utils/logger';
import { captureError } from './sentry';

/**
 * Checagem de índices no boot.
 *
 * O Mongoose cria os índices declarados no schema, mas NUNCA remove os que deixaram
 * de existir. Numa base que existiu antes do multi-cliente, um índice único antigo
 * (ex.: `contacts.email`) continua valendo e impede que dois clientes tenham o mesmo
 * registro — o código fica correto e o banco é que impõe a regra errada.
 *
 * O sintoma aparece tarde e disfarçado: um import legítimo é recusado como
 * "já cadastrado" meses depois, quando o segundo cliente esbarra no primeiro.
 * Esta verificação transforma isso em aviso na subida.
 *
 * Só avisa — nunca derruba a API. Um falso positivo não pode impedir o serviço de subir.
 */

export interface IndexIssue {
  collection: string;
  index: string;
  key: Record<string, unknown>;
}

/**
 * Procura índices ÚNICOS que não começam por `tenantId` nas collections com escopo
 * de cliente. Índices únicos globais são legítimos fora delas (User.email,
 * Tenant.slug, PlatformSettings.key), por isso a varredura é restrita ao que leva
 * o plugin `tenantScope`.
 */
/**
 * Um índice único também é seguro quando começa por uma REFERÊNCIA a outra entidade
 * do cliente. Ex.: `SendLog.{campaignId, contactId}` — a campanha já pertence a um
 * cliente, então dois clientes nunca compartilham um `campaignId` e a colisão entre
 * eles é impossível por construção.
 *
 * A dedução é automática (segue o `ref` do schema) para que um modelo novo com o
 * mesmo desenho não vire alarme falso — e alarme falso é o que faz o aviso ser ignorado.
 */
function apontaParaEntidadeDoCliente(schema: mongoose.Schema, caminho: string): boolean {
  const ref = schema.path(caminho)?.options?.ref;
  if (typeof ref !== 'string') return false;
  const referenciado = mongoose.models[ref];
  return Boolean(referenciado && isTenantScoped(referenciado.schema));
}

export async function findGlobalUniqueIndexes(): Promise<IndexIssue[]> {
  const issues: IndexIssue[] = [];

  for (const model of Object.values(mongoose.models)) {
    if (!isTenantScoped(model.schema)) continue;

    let indexes: Awaited<ReturnType<typeof model.collection.indexes>>;
    try {
      indexes = await model.collection.indexes();
    } catch {
      continue; // collection ainda não existe neste banco — nada a verificar
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

/** Roda a checagem e registra o resultado. Chamada no boot, depois de conectar. */
export async function verifyTenantIndexes(): Promise<IndexIssue[]> {
  let issues: IndexIssue[] = [];
  try {
    issues = await findGlobalUniqueIndexes();
  } catch (err) {
    // A checagem é diagnóstico: se ela própria falhar, não pode atrapalhar o boot.
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

  // Vale alerta em produção: é risco de o produto recusar dado legítimo de um cliente.
  captureError(new Error(`Índices únicos globais em collections multi-cliente: ${issues.length}`), {
    scope: 'indexGuard',
    issues,
  });

  return issues;
}
