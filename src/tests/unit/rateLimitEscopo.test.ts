import { describe, expect, it } from 'vitest';
import { ehConsultaDeProgresso } from '../../middleware/rateLimit';

// Só a leitura de progresso sai da cota: o polling da importação estourava o limite por IP.
const pede = (method: string, path: string) => ehConsultaDeProgresso({ method, path });

describe('escopo do limite geral', () => {
  it('deixa passar a leitura de progresso', () => {
    expect(pede('GET', '/api/contacts/import/6a9d23f9256cc4d77c3756a6')).toBe(true);
    expect(pede('GET', '/api/contacts/import/open')).toBe(true);
  });

  it('não abre a mão para o que muda estado', () => {
    expect(pede('POST', '/api/contacts/import')).toBe(false);
    expect(pede('POST', '/api/contacts/import/6a9d23f9256cc4d77c3756a6/confirm')).toBe(false);
    expect(pede('POST', '/api/contacts/import/6a9d23f9256cc4d77c3756a6/cancel')).toBe(false);
  });

  it('o relatório dos recusados continua na cota — é download, não acompanhamento', () => {
    expect(pede('GET', '/api/contacts/import/6a9d23f9256cc4d77c3756a6/invalid')).toBe(false);
  });

  it('não vale para outras rotas do sistema', () => {
    expect(pede('GET', '/api/contacts')).toBe(false);
    expect(pede('GET', '/api/campaigns/6a9d23f9256cc4d77c3756a6')).toBe(false);
    expect(pede('GET', '/api/dashboard/sends')).toBe(false);
  });
});
