import { defineConfig } from 'vitest/config';

/**
 * Testes de unidade: regra pura, sem banco, sem rede.
 *
 * Rodam em qualquer lugar (inclusive num CI sem serviços) e são a rede de segurança
 * do dia a dia. O que precisa de Mongo/Redis vive em `vitest.integration.config.ts`,
 * separado justamente para estes aqui nunca dependerem de infraestrutura.
 */
export default defineConfig({
  test: {
    include: ['src/tests/unit/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
