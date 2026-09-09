import { describe, expect, it } from 'vitest';
import { ehConsultaDeProgresso } from '../../middleware/rateLimit';

/**
 * Quais requisições ficam fora da cota geral.
 *
 * A tela de importação consulta o progresso enquanto o worker trabalha. Em intervalo
 * curto, uma única importação longa consumia sozinha as 200 requisições por 15 minutos
 * do limite geral — que é contado por IP —, e a pessoa levava 429 no meio do trabalho
 * enquanto o servidor terminava a importação normalmente.
 *
 * O recorte precisa ser estreito: só a LEITURA de progresso sai da cota. Subir arquivo,
 * confirmar e cancelar continuam contando, porque são as que mudam estado e são
 * justamente o que um abuso tentaria repetir.
 */
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
