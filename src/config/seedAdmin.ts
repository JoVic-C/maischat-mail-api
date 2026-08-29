import 'dotenv/config';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import User from '../models/User';
import { logger } from '../utils/logger';
import { getMongoUri } from './db';

async function seedAdmin(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL || 'admin@mmail.local').toLowerCase();
  // Sem ADMIN_PASSWORD, sorteia uma senha forte e imprime UMA vez — nunca um default
  // conhecido como "admin123", que na prática vira credencial pública em produção.
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  const name = process.env.ADMIN_NAME || 'Administrador da plataforma';

  await mongoose.connect(getMongoUri());
  const existing = await User.findOne({ email });
  if (existing) {
    logger.info(`Superadmin já existe: ${email}`);
  } else {
    // Superadmin: administra a PLATAFORMA (cria clientes), não pertence a nenhum
    // cliente. O admin de cada cliente nasce junto com o cliente, em POST /api/tenants.
    await User.create({ email, password, name, role: 'superadmin', tenantId: null, isActive: true });
    logger.info(`✅ Superadmin criado: ${email}  (senha: ${password})`);
  }
  await mongoose.connection.close();
}

seedAdmin().catch((err) => {
  console.error(err);
  process.exit(1);
});
