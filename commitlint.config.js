/** Conventional Commits: feat, fix, refactor, perf, docs, test, chore, build, ci. */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Libera acentos e maiúsculas no texto, em português.
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
