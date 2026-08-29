/**
 * Padrão de mensagem de commit: Conventional Commits.
 *   feat: nova função | fix: correção | refactor/perf/docs/test/chore/build/ci
 * Espelha as labels de Issue do fluxo do projeto (feature / fix / improvement).
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0], // permite acentuação e maiúsculas em português
    'header-max-length': [2, 'always', 100],
  },
};
