import fs from 'node:fs';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../../app';
import { criarCliente } from './fabricas';

/**
 * Quando o destino do arquivo não está gravável.
 *
 * O `mkdirSync` roda dentro do callback do multer, e a exceção subia crua: a tela
 * mostrava "Erro interno." e nada dizia se o problema era o arquivo enviado ou o
 * servidor. As duas causas reais — volume montado com dono diferente do usuário do
 * container, e disco cheio — são de infraestrutura, e a resposta precisa dizer isso.
 */
describe('destino do upload indisponível', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Faz a preparação do diretório falhar como o sistema de arquivos falharia. */
  function falharAoCriarDiretorio(codigo: string) {
    const original = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((caminho) => {
      if (String(caminho).includes('imports')) return false;
      return original(caminho);
    });
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      const erro = new Error(`${codigo}: falha simulada`) as NodeJS.ErrnoException;
      erro.code = codigo;
      throw erro;
    });
  }

  const csv = Buffer.from('email,nome\nana@exemplo.com,Ana\n');

  it('sem permissão de escrita, diz que é do servidor — não culpa o arquivo', async () => {
    const a = await criarCliente('Cliente A');
    falharAoCriarDiretorio('EACCES');

    const res = await request(app)
      .post('/api/contacts/import')
      .set(a.auth)
      .attach('file', csv, { filename: 'contatos.csv', contentType: 'text/csv' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/permissão para gravar/i);
    // Nada de caminho de disco ou código de erro do sistema na resposta.
    expect(JSON.stringify(res.body)).not.toMatch(/EACCES|\/app\/|data\/imports/);
  });

  it('disco cheio tem mensagem própria', async () => {
    const a = await criarCliente('Cliente A');
    falharAoCriarDiretorio('ENOSPC');

    const res = await request(app)
      .post('/api/contacts/import')
      .set(a.auth)
      .attach('file', csv, { filename: 'contatos.csv', contentType: 'text/csv' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/espaço em disco/i);
  });

  it('com o destino gravável, a importação segue normalmente', async () => {
    const a = await criarCliente('Cliente A');

    const res = await request(app)
      .post('/api/contacts/import')
      .set(a.auth)
      .attach('file', csv, { filename: 'contatos.csv', contentType: 'text/csv' })
      .expect(202);

    expect(res.body.id).toBeTruthy();
  });
});
