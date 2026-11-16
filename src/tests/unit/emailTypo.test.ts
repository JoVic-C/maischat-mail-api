import { describe, expect, it } from 'vitest';
import { editDistance, suggestDomain, suggestEmail } from '../../utils/emailTypo';

describe('editDistance', () => {
  it('conta letra a mais, a menos, trocada e invertida', () => {
    expect(editDistance('gmail.com', 'gmail.com')).toBe(0);
    expect(editDistance('gmaail.com', 'gmail.com')).toBe(1);
    expect(editDistance('gail.com', 'gmail.com')).toBe(1);
    expect(editDistance('gnail.com', 'gmail.com')).toBe(1);
    expect(editDistance('gmial.com', 'gmail.com')).toBe(1);
  });

  it('para cedo acima do limite', () => {
    expect(editDistance('empresa.com.br', 'gmail.com', 2)).toBe(3);
  });
});

describe('suggestDomain', () => {
  it.each([
    ['iclou.com', 'icloud.com'],
    ['cloud.com', 'icloud.com'],
    ['gail.com', 'gmail.com'],
    ['gmaail.com', 'gmail.com'],
    ['iclud.com', 'icloud.com'],
    ['icoud.com', 'icloud.com'],
    ['gmial.com', 'gmail.com'],
    ['gamil.com', 'gmail.com'],
    ['gmail.co', 'gmail.com'],
    ['hotmial.com', 'hotmail.com'],
    ['hotmail.co', 'hotmail.com'],
    ['hotmail.com.b', 'hotmail.com.br'],
    ['outlok.com', 'outlook.com'],
    ['yaho.com.br', 'yahoo.com.br'],
  ])('provedor popular: %s → %s', (errado, certo) => {
    expect(suggestDomain(errado)).toBe(certo);
  });

  it.each([
    ['gmail.con', 'gmail.com'],
    ['gmial.con', 'gmail.com'],
    ['empresa.con', 'empresa.com'],
    ['empresa.cmo.br', 'empresa.com.br'],
  ])('final inexistente: %s → %s', (errado, certo) => {
    expect(suggestDomain(errado)).toBe(certo);
  });

  it.each([
    ['gmail.com.br', 'gmail.com'],
    ['uol.com', 'uol.com.br'],
    ['terra.com', 'terra.com.br'],
  ])('mapa de erros comuns: %s → %s', (errado, certo) => {
    expect(suggestDomain(errado)).toBe(certo);
  });

  it.each([
    'gmail.com',
    'hotmail.com.br',
    'outlook.com.br',
    'uol.com.br',
    'bol.com.br',
    'ymail.com',
    'mail.com',
    'email.com',
    'me.com',
    'empresa.com.br',
    'maischat.com.br',
    'sol.com.br',
  ])('domínio real não é suspeito: %s', (dominio) => {
    expect(suggestDomain(dominio)).toBeNull();
  });

  it('ignora caixa e ponto final', () => {
    expect(suggestDomain(' GAIL.COM. ')).toBe('gmail.com');
  });

  it('domínio raro perto de um domínio dominante na base vira suspeito', () => {
    const references = new Map([
      ['maischat.com.br', 500],
      ['maischta.com.br', 12],
    ]);
    expect(suggestDomain('maischta.com.br', { references })).toBe('maischat.com.br');
    expect(suggestDomain('maischat.com.br', { references })).toBeNull();
    expect(suggestDomain('maiscaht.com.br', { references })).toBe('maischat.com.br');
  });

  it('duas empresas parecidas com volumes próximos não se acusam', () => {
    const references = new Map([
      ['empresa.com.br', 300],
      ['empresb.com.br', 40],
    ]);
    expect(suggestDomain('empresb.com.br', { references })).toBeNull();
  });

  it('ser frequente na base não livra um domínio parecido com provedor', () => {
    expect(suggestDomain('iclou.com', { references: new Map([['iclou.com', 80]]) })).toBe('icloud.com');
  });

  it('nome curto não é comparado com a base: colide demais', () => {
    expect(suggestDomain('abd.com.br', { references: new Map([['abc.com.br', 500]]) })).toBeNull();
  });

  it('empate entre dois domínios da base não sugere nada', () => {
    const references = new Map([
      ['empresb.com.br', 500],
      ['empresc.com.br', 500],
    ]);
    expect(suggestDomain('empresa.com.br', { references })).toBeNull();
  });

  it('domínio aceito pelo cliente não é suspeito', () => {
    expect(suggestDomain('cloud.com', { accepted: new Set(['cloud.com']) })).toBeNull();
  });
});
describe('suggestEmail', () => {
  it('mantém o que vem antes do @ e troca só o domínio', () => {
    expect(suggestEmail('Joao.Silva@gail.com')).toBe('joao.silva@gmail.com');
  });

  it('email sem suspeita ou sem @ devolve null', () => {
    expect(suggestEmail('ana@gmail.com')).toBeNull();
    expect(suggestEmail('sem-arroba')).toBeNull();
  });
});
