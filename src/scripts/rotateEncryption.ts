/**
 * Rotação da ENCRYPTION_KEY: reescreve os campos cifrados (Contact.phone,
 * SmtpSettings.password) com a chave atual. Idempotente.
 *
 *   1. ENCRYPTION_KEY_PREVIOUS = chave antiga; ENCRYPTION_KEY = chave nova
 *   2. npm run rotate:encryption
 *   3. remover ENCRYPTION_KEY_PREVIOUS do ambiente
 *
 * Faça backup antes. Valor que nenhuma das chaves abre é reportado e mantido intacto.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUri } from '../config/db';
import Contact from '../models/Contact';
import SmtpSettings from '../models/SmtpSettings';
import { decrypt, encrypt, isCurrentKey } from '../utils/fieldCrypto';
import { logger } from '../utils/logger';

interface Report {
  scanned: number;
  rotated: number;
  unreadable: number;
}

async function rotateField(
  label: string,
  model: typeof Contact | typeof SmtpSettings,
  field: 'phone' | 'password'
): Promise<Report> {
  const report: Report = { scanned: 0, rotated: 0, unreadable: 0 };

  // Direto na collection, sem os getters do schema: o valor cru, como está no banco.
  const cursor = model.collection.find({ [field]: { $regex: '^enc:v1:' } }, { projection: { [field]: 1 } });

  for await (const doc of cursor) {
    report.scanned++;
    const raw = String(doc[field] ?? '');
    if (isCurrentKey(raw)) continue;

    const plain = decrypt(raw);
    if (!plain) {
      report.unreadable++;
      logger.warn(`${label}: valor ilegível em ${String(doc._id)} — mantido como está`);
      continue;
    }

    await model.collection.updateOne({ _id: doc._id }, { $set: { [field]: encrypt(plain) } });
    report.rotated++;
  }

  return report;
}

async function main(): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY não definida.');
  if (!process.env.ENCRYPTION_KEY_PREVIOUS) {
    logger.warn('ENCRYPTION_KEY_PREVIOUS não definida — só valores já na chave atual serão reconhecidos.');
  }

  await mongoose.connect(getMongoUri());

  const contacts = await rotateField('Contact.phone', Contact, 'phone');
  const smtp = await rotateField('SmtpSettings.password', SmtpSettings, 'password');

  logger.info('🔐 Rotação concluída', {
    contacts: `${contacts.rotated}/${contacts.scanned} (ilegíveis: ${contacts.unreadable})`,
    smtp: `${smtp.rotated}/${smtp.scanned} (ilegíveis: ${smtp.unreadable})`,
  });

  await mongoose.connection.close();
}

main().catch((err) => {
  logger.error('Rotação falhou', { message: (err as Error).message });
  process.exit(1);
});
