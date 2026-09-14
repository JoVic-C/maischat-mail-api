/**
 * Migração da base sem dono para um cliente padrão:
 *   1. cria o cliente (slug de MIGRATION_TENANT_SLUG, padrão "principal");
 *   2. preenche `tenantId` nos documentos que não têm;
 *   3. vincula os usuários existentes, exceto superadmins;
 *   4. troca o índice único de `contacts.email` pelo composto {tenantId, email}.
 *
 * Idempotente. Escreve direto nas collections porque o plugin recusaria documentos sem
 * tenantId. Faça backup antes e rode com a API parada.
 *
 *   npm run migrate:multi-tenant
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUri } from '../config/db';
import Tenant from '../models/Tenant';
import { logger } from '../utils/logger';

const SCOPED_COLLECTIONS = [
  'contacts',
  'lists',
  'templates',
  'campaigns',
  'segments',
  'sendlogs',
  'smtpsettings',
] as const;

async function backfill(tenantId: mongoose.Types.ObjectId): Promise<void> {
  for (const name of SCOPED_COLLECTIONS) {
    const collection = mongoose.connection.collection(name);
    const res = await collection.updateMany({ tenantId: { $exists: false } }, { $set: { tenantId } });
    logger.info(`📦 ${name}: ${res.modifiedCount} documento(s) migrado(s)`);
  }
}

async function fixContactIndexes(): Promise<void> {
  const contacts = mongoose.connection.collection('contacts');
  const indexes = await contacts.indexes();

  const legacy = indexes.find((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ email: 1 }));
  if (legacy?.name) {
    await contacts.dropIndex(legacy.name);
    logger.info(`🔧 Índice único legado removido: ${legacy.name}`);
  }

  await contacts.createIndex({ tenantId: 1, email: 1 }, { unique: true });
  logger.info('🔧 Índice único {tenantId, email} garantido');
}

async function linkUsers(tenantId: mongoose.Types.ObjectId): Promise<void> {
  const users = mongoose.connection.collection('users');
  const res = await users.updateMany(
    { role: { $ne: 'superadmin' }, $or: [{ tenantId: { $exists: false } }, { tenantId: null }] },
    { $set: { tenantId } }
  );
  logger.info(`👤 users: ${res.modifiedCount} vinculado(s) ao cliente padrão`);
}

async function main(): Promise<void> {
  await mongoose.connect(getMongoUri());

  const slug = (process.env.MIGRATION_TENANT_SLUG || 'principal').toLowerCase();
  const name = process.env.MIGRATION_TENANT_NAME || 'Cliente principal';

  const tenant = (await Tenant.findOne({ slug })) ?? (await Tenant.create({ name, slug, isActive: true }));
  logger.info(`🏢 Cliente padrão: ${tenant.slug} (${tenant._id})`);

  await backfill(tenant._id);
  await linkUsers(tenant._id);
  await fixContactIndexes();

  logger.info('✅ Migração concluída. Confira o app antes de liberar o acesso.');
  await mongoose.connection.close();
}

main().catch((err) => {
  logger.error('Migração falhou', { message: (err as Error).message });
  process.exit(1);
});
