import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { MONGO_URI_TEST, REDIS_URL_TEST } from './globalSetup';

// Definidas antes de qualquer import da app: `fieldCrypto`, `authService` e a conexão do Redis
// leem o ambiente na primeira chamada e, senão, pegariam o `.env` de desenvolvimento.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste-nao-usar-em-producao';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'chave-de-teste-nao-usar-em-producao';
process.env.MONGO_URI = MONGO_URI_TEST;
process.env.REDIS_URL = REDIS_URL_TEST;
// O limitador conta no Redis durante a rodada; teto alto evita 429 entre suítes.
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.RATE_LIMIT_AUTH_MAX = '100000';

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI as string);
});

beforeEach(async () => {
  const colecoes = await mongoose.connection.db?.collections();
  for (const c of colecoes ?? []) await c.deleteMany({});
});

afterAll(async () => {
  await mongoose.connection.close();
});
