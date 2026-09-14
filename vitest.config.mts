import { defineConfig } from 'vitest/config';

/** Unidade: sem banco e sem rede. O que precisa de Mongo e Redis fica na config de integração. */
export default defineConfig({
  test: {
    include: ['src/tests/unit/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
