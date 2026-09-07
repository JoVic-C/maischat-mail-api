import { beforeAll, describe, expect, it } from 'vitest';
import { EMAIL_RE } from '../../utils/emailHygiene';
import { escapeRegex } from '../../utils/regex';
import { isLegacyExcel, isSupportedSheet, sheetExtension } from '../../utils/sheetStream';

// A criptografia de campo lê a chave do ambiente no momento da chamada.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'chave-de-teste-'.repeat(4);
});

describe('EMAIL_RE', () => {
  it.each(['ana@x.com', 'ana.souza@empresa.com.br', 'ana+lista@x.io', 'a@b.co'])('aceita %s', (email) => {
    expect(EMAIL_RE.test(email)).toBe(true);
  });

  it.each([
    ['sem arroba', 'anax.com'],
    ['sem domínio', 'ana@'],
    ['sem ponto no domínio', 'ana@x'],
    ['com espaço', 'ana souza@x.com'],
    ['vazio', ''],
    ['dois arrobas', 'a@b@c.com'],
  ])('recusa %s', (_caso, email) => {
    expect(EMAIL_RE.test(email)).toBe(false);
  });
});

describe('escapeRegex', () => {
  it('neutraliza metacaracteres para a busca não virar regex do usuário', () => {
    // Sem escapar, buscar "(" derruba a query com 500 — e padrões custosos viram ReDoS.
    expect(escapeRegex('a(b)c')).toBe('a\\(b\\)c');
    expect(escapeRegex('.*')).toBe('\\.\\*');
  });

  it('deixa texto comum intacto', () => {
    expect(escapeRegex('joão silva')).toBe('joão silva');
  });
});

describe('formatos de planilha aceitos', () => {
  it('aceita csv, txt e xlsx', () => {
    expect(isSupportedSheet('contatos.csv')).toBe(true);
    expect(isSupportedSheet('contatos.txt')).toBe(true);
    expect(isSupportedSheet('contatos.xlsx')).toBe(true);
  });

  it('recusa formatos que não sabemos ler', () => {
    expect(isSupportedSheet('documento.pdf')).toBe(false);
    expect(isSupportedSheet('planilha.ods')).toBe(false);
    expect(isSupportedSheet('semextensao')).toBe(false);
  });

  it('identifica o .xls antigo em separado, para dar mensagem específica', () => {
    // "arquivo inválido" não ajuda quem subiu uma planilha de verdade; a mensagem
    // precisa dizer para salvar como .xlsx.
    expect(isLegacyExcel('base.xls')).toBe(true);
    expect(isSupportedSheet('base.xls')).toBe(false);
  });

  it('não se confunde com maiúsculas nem com ponto no nome', () => {
    expect(isSupportedSheet('BASE.CSV')).toBe(true);
    expect(sheetExtension('base.de.contatos.xlsx')).toBe('.xlsx');
  });
});
