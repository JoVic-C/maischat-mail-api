import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../../app';
import { runWithTenant } from '../../config/tenantContext';
import Contact from '../../models/Contact';
import List from '../../models/List';
import { criarCliente } from './fabricas';

/**
 * Exportação de contatos.
 *
 * É a única funcionalidade que tira a base de dentro do sistema, então tem dois riscos
 * próprios: sair incompleta (perder colunas que vieram do CSV, ou o telefone cifrado) e
 * sair para o cliente errado.
 */
async function criarLista(tenantId: string, nome: string) {
  return runWithTenant(tenantId, async () => await List.create({ name: nome }));
}

async function criarContato(tenantId: string, dados: Record<string, unknown>) {
  return runWithTenant(tenantId, async () => await Contact.create(dados));
}

/** Quebra o CSV em linhas, ignorando o BOM do início. */
function linhas(csv: string): string[] {
  return csv.replace(/^﻿/, '').trim().split('\r\n');
}

describe('exportação de contatos', () => {
  it('devolve CSV com cabeçalho e uma linha por contato', async () => {
    const a = await criarCliente('Cliente A');
    const lista = await criarLista(String(a.tenant._id), 'Clientes ativos');
    await criarContato(String(a.tenant._id), { email: 'ana@x.com', name: 'Ana', company: 'ACME', lists: [lista._id] });
    await criarContato(String(a.tenant._id), { email: 'bruno@x.com', name: 'Bruno', lists: [lista._id] });

    const res = await request(app).get('/api/contacts/export').set(a.auth).expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    const l = linhas(res.text);
    expect(l).toHaveLength(3); // cabeçalho + 2 contatos
    expect(l[0]).toContain('email;');
    expect(res.text).toContain('ana@x.com');
    expect(res.text).toContain('bruno@x.com');
  });

  it('o nome do arquivo sai com o nome da lista quando se exporta uma lista', async () => {
    const a = await criarCliente('Cliente A');
    const lista = await criarLista(String(a.tenant._id), 'Farmácias BR');
    await criarContato(String(a.tenant._id), { email: 'ana@x.com', lists: [lista._id] });

    const res = await request(app)
      .get('/api/contacts/export')
      .query({ listId: String(lista._id) })
      .set(a.auth)
      .expect(200);

    // acento vira forma simples: o nome precisa ser seguro para o sistema de arquivos
    expect(res.headers['content-disposition']).toContain('contatos-farmacias-br-');
  });

  it('exporta só os contatos da lista pedida', async () => {
    const a = await criarCliente('Cliente A');
    const umaLista = await criarLista(String(a.tenant._id), 'Lista A');
    const outraLista = await criarLista(String(a.tenant._id), 'Lista B');
    await criarContato(String(a.tenant._id), { email: 'daqui@x.com', lists: [umaLista._id] });
    await criarContato(String(a.tenant._id), { email: 'dali@x.com', lists: [outraLista._id] });

    const res = await request(app)
      .get('/api/contacts/export')
      .query({ listId: String(umaLista._id) })
      .set(a.auth)
      .expect(200);

    expect(res.text).toContain('daqui@x.com');
    expect(res.text).not.toContain('dali@x.com');
  });

  it('respeita os mesmos filtros da tela (situação e busca)', async () => {
    const a = await criarCliente('Cliente A');
    await criarContato(String(a.tenant._id), { email: 'ativo@x.com', status: 'active' });
    await criarContato(String(a.tenant._id), { email: 'saiu@x.com', status: 'unsubscribed' });

    const porSituacao = await request(app)
      .get('/api/contacts/export')
      .query({ status: 'unsubscribed' })
      .set(a.auth)
      .expect(200);
    expect(porSituacao.text).toContain('saiu@x.com');
    expect(porSituacao.text).not.toContain('ativo@x.com');

    const porBusca = await request(app).get('/api/contacts/export').query({ search: 'ativo' }).set(a.auth).expect(200);
    expect(porBusca.text).toContain('ativo@x.com');
    expect(porBusca.text).not.toContain('saiu@x.com');
  });

  it('devolve o telefone LEGÍVEL, não o valor cifrado do banco', async () => {
    // O telefone é gravado cifrado. Exportar o ciphertext entregaria um arquivo inútil.
    const a = await criarCliente('Cliente A');
    await criarContato(String(a.tenant._id), { email: 'ana@x.com', phone: '11999990001' });

    const res = await request(app).get('/api/contacts/export').set(a.auth).expect(200);

    expect(res.text).toContain('11999990001');
    expect(res.text).not.toContain('enc:v1:');
  });

  it('traz as colunas extras que vieram do CSV importado', async () => {
    // Sem isto o arquivo exportado perde dado e não pode ser reimportado inteiro.
    const a = await criarCliente('Cliente A');
    await criarContato(String(a.tenant._id), {
      email: 'ana@x.com',
      metadata: new Map([
        ['plano', 'ouro'],
        ['cidade', 'Recife'],
      ]),
    });

    const res = await request(app).get('/api/contacts/export').set(a.auth).expect(200);
    const l = linhas(res.text);

    expect(l[0]).toContain('cidade');
    expect(l[0]).toContain('plano');
    expect(l[1]).toContain('ouro');
    expect(l[1]).toContain('Recife');
  });

  it('traz as colunas extras TAMBÉM quando se filtra por lista', async () => {
    // Regressão: a busca das colunas extras usa aggregate, que — ao contrário do find —
    // não converte o id de texto para ObjectId. Com string, ela não casava com nada e o
    // arquivo saía sem as colunas, em silêncio, justo no caso principal.
    const a = await criarCliente('Cliente A');
    const lista = await criarLista(String(a.tenant._id), 'Com metadata');
    await criarContato(String(a.tenant._id), {
      email: 'ana@x.com',
      lists: [lista._id],
      metadata: new Map([['plano', 'ouro']]),
    });

    const res = await request(app)
      .get('/api/contacts/export')
      .query({ listId: String(lista._id) })
      .set(a.auth)
      .expect(200);

    const l = linhas(res.text);
    expect(l[0]).toContain('plano');
    expect(l[1]).toContain('ouro');
  });

  it('escapa aspas para um nome não quebrar a coluna', async () => {
    const a = await criarCliente('Cliente A');
    await criarContato(String(a.tenant._id), { email: 'ana@x.com', name: 'Ana "A Chefe" Souza' });

    const res = await request(app).get('/api/contacts/export').set(a.auth).expect(200);

    expect(res.text).toContain('""A Chefe""');
    expect(linhas(res.text)).toHaveLength(2);
  });

  it('NÃO exporta contatos de outro cliente, nem passando o id da lista dele', async () => {
    const a = await criarCliente('Cliente A');
    const b = await criarCliente('Cliente B');
    const listaDoB = await criarLista(String(b.tenant._id), 'Lista do B');
    await criarContato(String(b.tenant._id), { email: 'segredo@x.com', lists: [listaDoB._id] });

    // Sem filtro: o escopo por cliente já barra.
    const tudo = await request(app).get('/api/contacts/export').set(a.auth).expect(200);
    expect(tudo.text).not.toContain('segredo@x.com');

    // Com o id da lista alheia: a lista não existe para o cliente A.
    await request(app)
      .get('/api/contacts/export')
      .query({ listId: String(listaDoB._id) })
      .set(a.auth)
      .expect(404);
  });

  it('não repete no cabeçalho uma coluna fixa que também exista como campo extra', async () => {
    // Reimportar um arquivo exportado guardava 'situacao' como campo extra; a exportação
    // seguinte traria a mesma coluna duas vezes e o CSV sairia ambíguo.
    const a = await criarCliente('Cliente A');
    await criarContato(String(a.tenant._id), {
      email: 'ana@x.com',
      metadata: new Map([['situacao', 'valor antigo']]),
    });

    const res = await request(app).get('/api/contacts/export').set(a.auth).expect(200);
    const cabecalho = linhas(res.text)[0].split(';');

    expect(cabecalho.filter((c) => c === 'situacao')).toHaveLength(1);
  });

  it('sem token não exporta nada', async () => {
    await request(app).get('/api/contacts/export').expect(401);
  });

  it('base vazia devolve só o cabeçalho, não um erro', async () => {
    const a = await criarCliente('Cliente A');
    const res = await request(app).get('/api/contacts/export').set(a.auth).expect(200);
    expect(linhas(res.text)).toHaveLength(1);
  });

  it('recusa filtro inválido em vez de ignorá-lo em silêncio', async () => {
    const a = await criarCliente('Cliente A');
    await request(app).get('/api/contacts/export').query({ status: 'inventado' }).set(a.auth).expect(400);
  });
});
