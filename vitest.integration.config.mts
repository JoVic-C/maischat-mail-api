import { defineConfig } from 'vitest/config';

/**
 * Integração: a API real contra Mongo e Redis, num banco próprio (MONGO_URI_TEST) que é
 * limpo entre os testes. Sequencial porque as suítes compartilham esse banco.
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
