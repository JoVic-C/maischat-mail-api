import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../../app';
import { criarCliente } from './fabricas';

/**
 * O que a API conta ao cliente quando algo dá errado.
 *
 * A regra é uma só: a resposta diz o que aconteceu, sem devolver a requisição nem as
 * entranhas do servidor. O 404 chegou a responder `Rota não encontrada: GET
 * /api/dashboard/sends?de=...&ate=...`, que apareceu inteiro num aviso do painel —
 * método, caminho e a query string do próprio cliente, de volta na tela.
 */
describe('mensagens de erro', () => {
  it('rota inexistente não devolve o método, o caminho nem a query', async () => {
    // Com token: sem ele o requireAuth do prefixo responde 401 antes, e o 404 genérico
    // nem chega a ser alcançado — que é justamente o caso do painel logado.
    const a = await criarCliente('Cliente A');
    const res = await request(app)
      .get('/api/dashboard/relatorio-que-nao-existe?token=segredo&de=2026-01-01')
      .set(a.auth)
      .expect(404);

    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain('GET');
    expect(corpo).not.toContain('/api/dashboard');
    expect(corpo).not.toContain('segredo');
    expect(corpo).not.toContain('2026-01-01');

    // O código deixa o painel explicar que o servidor está atrás — sem repetir a URL.
    expect(res.body.code).toBe('ROTA_INEXISTENTE');
    expect(res.body.error).toBe('Recurso não encontrado.');
  });

  it('vale também para o método errado numa rota que existe', async () => {
    const res = await request(app).post('/api/health').expect(404);
    expect(JSON.stringify(res.body)).not.toContain('/api/health');
  });

  it('data inválida fala em "data inicial", não no nome do parâmetro da API', async () => {
    const a = await criarCliente('Cliente A');
    const res = await request(app)
      .get('/api/dashboard/sends')
      .query({ de: '2026-02-30T99:00:00Z' })
      .set(a.auth)
      .expect(400);

    // A mensagem que o painel exibe é a do campo; o `error` é só o resumo do lote.
    const mensagem = res.body.errors?.[0]?.message ?? res.body.error;
    expect(mensagem).not.toContain('"de"');
    expect(mensagem).toMatch(/data inicial/i);
  });

  it('email repetido não devolve o nome do índice do Mongo', async () => {
    const a = await criarCliente('Cliente A');
    const email = 'repetido@exemplo.com';
    await request(app).post('/api/contacts').set(a.auth).send({ email, name: 'Primeiro' }).expect(201);

    const res = await request(app).post('/api/contacts').set(a.auth).send({ email, name: 'Segundo' });

    expect([400, 409]).toContain(res.status);
    // "tenantId_1_email_1" não diz nada a quem preencheu o formulário.
    expect(res.body.error).not.toMatch(/tenantId|_1|index/i);
  });

  it('identificador malformado é 400, não 500', async () => {
    // Um campo que o painel deixou de preencher chega como a string "undefined". O
    // `new Types.ObjectId()` lançava BSONError, que ninguém tratava, e o resultado era
    // "Erro interno." — indistinguível de um defeito do servidor. São nove conversões
    // assim nos serviços; o tratamento é central.
    const a = await criarCliente('Cliente A');
    const csv = Buffer.from('email,nome\nana@exemplo.com,Ana\n');

    const res = await request(app)
      .post('/api/contacts/import')
      .set(a.auth)
      .field('listIds', 'undefined')
      .attach('file', csv, { filename: 'c.csv', contentType: 'text/csv' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ID_INVALIDO');
    // Sem devolver o texto do driver ("24 character hex string...").
    expect(res.body.error).not.toMatch(/hex|Uint8Array|BSON/i);
  });

  it('vale para qualquer rota, não só a importação', async () => {
    const a = await criarCliente('Cliente A');
    const res = await request(app).get('/api/contacts/nao-e-um-id').set(a.auth);

    expect(res.status).toBe(400);
    expect(res.body.error).not.toMatch(/hex|Uint8Array|BSON/i);
  });

  it('arquivo grande demais informa o limite daquele upload, não um número fixo', async () => {
    const a = await criarCliente('Cliente A');
    // O limite de imagem é 5 MB; a mensagem antiga dizia "máx. 5 MB" para todos os
    // uploads, inclusive o de planilha, cujo limite é 100 MB.
    const grande = Buffer.alloc(6 * 1024 * 1024, 0);

    const res = await request(app)
      .post('/api/upload/image')
      .set(a.auth)
      .attach('image', grande, { filename: 'grande.png', contentType: 'image/png' })
      .expect(400);

    expect(res.body.error).toMatch(/5 MB/);
    expect(res.body.error).not.toMatch(/LIMIT_|multer/i);
  });
});
