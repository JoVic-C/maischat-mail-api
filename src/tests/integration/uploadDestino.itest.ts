import fs from 'node:fs';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../../app';
import { criarCliente } from './fabricas';

describe('destino do upload indisponível', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

// Cenário do volume montado com dono diferente do usuário do container.
describe('destino existe mas não é gravável', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('avisa que é permissão, em vez de deixar o upload falhar sem explicação', async () => {
    const a = await criarCliente('Cliente A');

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {
      const erro = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      erro.code = 'EACCES';
      throw erro;
    });

    const res = await request(app)
      .post('/api/contacts/import')
      .set(a.auth)
      .attach('file', Buffer.from('email\nana@exemplo.com\n'), { filename: 'c.csv', contentType: 'text/csv' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/permissão para gravar/i);
    expect(res.body.error).not.toMatch(/Erro interno/i);
  });
});
