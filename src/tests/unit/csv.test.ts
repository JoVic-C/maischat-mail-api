import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, splitLine } from '../../utils/csv';

/**
 * O parser de CSV é a porta de entrada dos contatos: um erro aqui não quebra a
 * aplicação, ele importa dado errado em silêncio. Daí a cobertura ser sobre os casos
 * que aparecem em planilha de cliente de verdade — ponto e vírgula, aspas, acento,
 * coluna faltando — e não sobre o caminho feliz.
 */

describe('detectDelimiter', () => {
  it('escolhe ponto e vírgula quando ele domina o cabeçalho', () => {
    expect(detectDelimiter('nome;email;empresa')).toBe(';');
  });

  it('escolhe vírgula quando ela domina', () => {
    expect(detectDelimiter('nome,email,empresa')).toBe(',');
  });

  it('na dúvida fica na vírgula, que é o padrão do formato', () => {
    expect(detectDelimiter('email')).toBe(',');
  });

  it('um nome com vírgula dentro não faz o cabeçalho de ; virar de ,', () => {
    // "Silva, João" no cabeçalho é raro, mas o empate não pode virar delimitador errado
    expect(detectDelimiter('nome;email;observação, com vírgula')).toBe(';');
  });
});

describe('splitLine', () => {
  it('mantém o delimitador que está dentro de aspas', () => {
    expect(splitLine('"ACME, LTDA";a@x.com', ';')).toEqual(['ACME, LTDA', 'a@x.com']);
  });

  it('desdobra aspas duplicadas em uma só', () => {
    expect(splitLine('"Empresa ""X""";a@x.com', ';')).toEqual(['Empresa "X"', 'a@x.com']);
  });

  it('preserva campos vazios no meio, para não desalinhar as colunas', () => {
    expect(splitLine('a;;c', ';')).toEqual(['a', '', 'c']);
  });

  it('apara espaços em volta dos valores', () => {
    expect(splitLine(' a ; b ', ';')).toEqual(['a', 'b']);
  });
});

describe('parseCsv', () => {
  it('mapeia as colunas pelo cabeçalho, em minúsculas', () => {
    const linhas = parseCsv('Nome;E-mail\nAna;ana@x.com');
    expect(linhas).toEqual([{ nome: 'Ana', 'e-mail': 'ana@x.com' }]);
  });

  it('ignora linhas em branco no meio do arquivo', () => {
    const linhas = parseCsv('nome;email\nAna;ana@x.com\n\nBruno;bruno@x.com\n');
    expect(linhas).toHaveLength(2);
  });

  it('remove o BOM que o Excel grava no início do arquivo', () => {
    // Sem isto a primeira coluna vira "﻿email" e o email nunca é encontrado.
    const linhas = parseCsv('﻿email\nana@x.com');
    expect(linhas[0]).toEqual({ email: 'ana@x.com' });
  });

  it('completa com string vazia quando a linha tem menos colunas que o cabeçalho', () => {
    const linhas = parseCsv('nome;email;empresa\nAna;ana@x.com');
    expect(linhas[0]).toEqual({ nome: 'Ana', email: 'ana@x.com', empresa: '' });
  });

  it('devolve vazio quando só há cabeçalho', () => {
    expect(parseCsv('nome;email')).toEqual([]);
  });

  it('devolve vazio para conteúdo vazio', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('aceita quebra de linha do Windows', () => {
    const linhas = parseCsv('nome;email\r\nAna;ana@x.com\r\n');
    expect(linhas).toEqual([{ nome: 'Ana', email: 'ana@x.com' }]);
  });
});
