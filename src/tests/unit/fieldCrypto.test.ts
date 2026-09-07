import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt, isCurrentKey } from '../../utils/fieldCrypto';

/**
 * O telefone do contato é gravado cifrado. Os testes aqui cobrem o que protege o dado
 * de verdade: que o valor não trafega em claro, que um dado adulterado NÃO é aceito
 * (AES-GCM autentica), e que a janela de rotação de chave funciona — sem ela, trocar a
 * chave tornaria toda a base ilegível.
 */

const CHAVE_ATUAL = 'chave-atual-para-testes-0123456789';
const CHAVE_ANTERIOR = 'chave-anterior-para-testes-987654';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = CHAVE_ATUAL;
  process.env.ENCRYPTION_KEY_PREVIOUS = '';
});

afterEach(() => {
  process.env.ENCRYPTION_KEY_PREVIOUS = '';
});

describe('criptografia de campo', () => {
  it('vai e volta preservando o valor', () => {
    expect(decrypt(encrypt('11999990001'))).toBe('11999990001');
  });

  it('o valor cifrado não contém o texto original', () => {
    const cifrado = encrypt('11999990001');
    expect(cifrado).not.toContain('11999990001');
    expect(cifrado.startsWith('enc:v1:')).toBe(true);
  });

  it('cifrar duas vezes o mesmo valor gera saídas diferentes (IV aleatório)', () => {
    // Saídas iguais permitiriam deduzir quem tem o mesmo telefone só olhando o banco.
    expect(encrypt('11999990001')).not.toBe(encrypt('11999990001'));
  });

  it('não cifra de novo o que já está cifrado', () => {
    const uma = encrypt('11999990001');
    expect(encrypt(uma)).toBe(uma);
  });

  it('deixa passar valor vazio sem quebrar', () => {
    expect(encrypt('')).toBe('');
    expect(decrypt('')).toBe('');
  });

  it('devolve como está o texto legado, não cifrado', () => {
    // Base anterior à criptografia continua legível durante a migração.
    expect(decrypt('11999990001')).toBe('11999990001');
  });

  it('recusa dado adulterado em vez de devolver lixo', () => {
    const cifrado = encrypt('11999990001');
    // troca um caractere do payload: o GCM tem que reprovar a autenticação
    const adulterado = `${cifrado.slice(0, -4)}AAAA`;
    const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(decrypt(adulterado)).toBe('');
    erro.mockRestore();
  });

  it('com a chave trocada e sem a anterior, o dado antigo não abre', () => {
    const antigo = encrypt('11999990001');
    process.env.ENCRYPTION_KEY = 'outra-chave-totalmente-diferente-1';
    const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(decrypt(antigo)).toBe('');
    erro.mockRestore();
  });

  it('durante a rotação, a chave anterior ainda abre o dado antigo', () => {
    process.env.ENCRYPTION_KEY = CHAVE_ANTERIOR;
    const antigo = encrypt('11999990001');

    // publica a chave nova mantendo a anterior — é o estado da janela de rotação
    process.env.ENCRYPTION_KEY = CHAVE_ATUAL;
    process.env.ENCRYPTION_KEY_PREVIOUS = CHAVE_ANTERIOR;

    expect(decrypt(antigo)).toBe('11999990001');
    // e o script de rotação consegue distinguir o que falta reescrever
    expect(isCurrentKey(antigo)).toBe(false);
    expect(isCurrentKey(encrypt('novo'))).toBe(true);
  });
});
