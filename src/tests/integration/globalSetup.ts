import { Redis } from 'ioredis';
import mongoose from 'mongoose';

export const MONGO_URI_TEST = process.env.MONGO_URI_TEST || 'mongodb://localhost:27017/mailpulse_test';

// Banco próprio: no 0, o worker do `npm run dev` consumiria os jobs criados pelos testes.
export const REDIS_URL_TEST = process.env.REDIS_URL_TEST || 'redis://localhost:6379/15';

async function prepararMongo(): Promise<void> {
  try {
    await mongoose.connect(MONGO_URI_TEST, { serverSelectionTimeoutMS: 4000 });
    await mongoose.connection.close();
  } catch {
    throw new Error(
      `Não consegui conectar no Mongo de teste (${MONGO_URI_TEST}).\n` +
        'Suba os serviços antes: docker compose up -d mongo redis\n' +
        'Ou aponte outro banco em MONGO_URI_TEST.'
    );
  }
}

async function prepararRedis(): Promise<void> {
  const banco = Number(new URL(REDIS_URL_TEST).pathname.slice(1) || 0);
  if (banco === 0) {
    throw new Error('REDIS_URL_TEST precisa apontar para um banco diferente do 0, que é o do desenvolvimento.');
  }

  const redis = new Redis(REDIS_URL_TEST, {
    lazyConnect: true,
    connectTimeout: 4000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    await redis.flushdb();
  } catch {
    throw new Error(
      `Não consegui conectar no Redis de teste (${REDIS_URL_TEST}).\n` +
        'Suba os serviços antes: docker compose up -d mongo redis\n' +
        'Ou aponte outro banco em REDIS_URL_TEST.'
    );
  } finally {
    redis.disconnect();
  }
}

export default async function globalSetup(): Promise<void> {
  await prepararMongo();
  await prepararRedis();
}
