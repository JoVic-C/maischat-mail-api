import mongoose from 'mongoose';

/**
 * Roda uma vez antes de toda a suíte, só para falhar com uma mensagem útil.
 *
 * Sem isto, um Mongo fora do ar aparece como um timeout genérico em cada teste, e o
 * tempo vai embora procurando bug onde não há.
 */
export default async function globalSetup(): Promise<void> {
  const uri = process.env.MONGO_URI_TEST || 'mongodb://localhost:27017/mailpulse_test';

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
    await mongoose.connection.close();
  } catch {
    throw new Error(
      `Não consegui conectar no Mongo de teste (${uri}).\n` +
        'Suba os serviços antes: docker compose up -d mongo redis\n' +
        'Ou aponte outro banco em MONGO_URI_TEST.'
    );
  }
}
