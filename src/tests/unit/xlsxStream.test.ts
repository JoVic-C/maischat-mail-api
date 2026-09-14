import { describe, expect, it } from 'vitest';
import { cellText } from '../../utils/xlsxStream';

describe('cellText', () => {
  it('devolve string aparada', () => {
    expect(cellText('  ana@x.com  ')).toBe('ana@x.com');
  });

  it('converte número (telefone guardado como number)', () => {
    expect(cellText(11999990001)).toBe('11999990001');
  });

  it('trata vazio como string vazia, não como "null"', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
  });

  it('resolve hyperlink pelo rótulo — é o que o Excel cria ao digitar um email', () => {
    expect(cellText({ text: 'bruno@x.com', hyperlink: 'mailto:bruno@x.com' })).toBe('bruno@x.com');
  });

  it('usa o hyperlink sem o mailto: quando não há rótulo', () => {
    expect(cellText({ hyperlink: 'mailto:carla@x.com' })).toBe('carla@x.com');
  });

  it('junta texto formatado preservando o espaço entre os trechos', () => {
    // Aparar cada trecho antes de juntar transformaria "Carla " + "Dias" em "CarlaDias".
    const valor = { richText: [{ text: 'Carla ' }, { text: 'Dias' }] };
    expect(cellText(valor)).toBe('Carla Dias');
  });

  it('usa o resultado da fórmula, não a expressão', () => {
    expect(cellText({ formula: 'CONCATENATE("a","@x.com")', result: 'a@x.com' })).toBe('a@x.com');
  });

  it('trata célula em erro (#N/A) como vazia', () => {
    expect(cellText({ error: '#N/A' })).toBe('');
  });

  it('converte data para ISO', () => {
    expect(cellText(new Date('2026-01-15T10:00:00.000Z'))).toBe('2026-01-15T10:00:00.000Z');
  });

  it('nunca devolve "[object Object]" para um objeto desconhecido vazio', () => {
    expect(cellText({ algo: 'inesperado' })).not.toContain('[object');
  });
});
