import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';

/**
 * Preparo de cada arquivo de teste de integração.
 *
 * As variáveis são definidas AQUI, antes de qualquer import da aplicação: o
 * `fieldCrypto` e o `authService` leem o ambiente na primeira chamada, e um arquivo de
 * teste que importe a app antes disso pegaria a configuração do `.env` de
 * desenvolvimento — inclusive o banco real.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste-nao-usar-em-producao';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'chave-de-teste-nao-usar-em-producao';
process.env.MONGO_URI = process.env.MONGO_URI_TEST || 'mongodb://localhost:27017/mailpulse_test';
// O limitador é por Redis e conta entre execuções; um teto alto evita que a suíte
// comece a receber 429 por causa de uma rodada anterior.
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.RATE_LIMIT_AUTH_MAX = '100000';

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI as string);
});

beforeEach(async () => {
  // Banco limpo a cada teste: um teste nunca deve depender do que outro deixou.
  const colecoes = await mongoose.connection.db?.collections();
  for (const c of colecoes ?? []) await c.deleteMany({});
});

afterAll(async () => {
  await mongoose.connection.close();
});
