import { defineConfig } from 'vitest/config';

/**
 * Testes de integração: sobem a API de verdade (supertest) contra Mongo e Redis.
 *
 * Exigem os serviços no ar — `docker compose up -d mongo redis` localmente, ou os
 * containers de serviço do CI. Usam um banco PRÓPRIO (MONGO_URI_TEST), nunca o de
 * desenvolvimento: as suítes apagam coleções entre os testes.
 *
 * Sequenciais de propósito: compartilham o mesmo banco, e rodar em paralelo faria
 * uma suíte limpar os dados da outra.
 */
export default defineConfig({
  test: {
    include: ['src/tests/integration/**/*.itest.ts'],
    environment: 'node',
    globalSetup: ['src/tests/integration/globalSetup.ts'],
    setupFiles: ['src/tests/integration/setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    restoreMocks: true,
  },
});
