import mongoose from 'mongoose';
import { logger, logSideEffect } from '../utils/logger';
import { verifyTenantIndexes } from './indexGuard';

export function getMongoUri(): string {
  if (process.env.MONGO_URI) return process.env.MONGO_URI;
  throw new Error('MongoDB not configured: set MONGO_URI in .env');
}

export async function connectDB(): Promise<void> {
  try {
    logger.info('🚀 Connecting to MongoDB...');
    const conn = await mongoose.connect(getMongoUri());
    logger.info(`🟢 MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);

    // Diagnóstico do isolamento por cliente. Só avisa — nunca impede a subida.
    await verifyTenantIndexes();
  } catch (err) {
    logSideEffect('db.connect', err);
    process.exit(1);
  }
}

export async function disconnectDB(): Promise<void> {
  await mongoose.connection.close();
  logger.info('🔴 MongoDB connection closed');
}

export default connectDB;
