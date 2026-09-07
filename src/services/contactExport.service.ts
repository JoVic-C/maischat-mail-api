/**
 * Exportação de contatos em CSV.
 *
 * Aceita os MESMOS filtros da listagem da tela, então um único caminho serve para
 * "exportar esta lista" (filtrando por lista) e para "exportar o que estou vendo"
 * (com busca e filtros aplicados). Duas rotas para a mesma coisa só criariam duas
 * chances de divergir.
 *
 * O arquivo é escrito na resposta enquanto é lido do banco, a partir de um cursor:
 * exportar uma lista de milhões de contatos não pode depender de caber em memória.
 */
import type { Response } from 'express';
import { Types } from 'mongoose';
import { NotFoundError } from '../errors';
import Contact, { type IContact } from '../models/Contact';
import List from '../models/List';
import { csvDate, csvRow, safeFileName, startCsvDownload, writeCsvLine } from '../utils/csvResponse';
import { decrypt } from '../utils/fieldCrypto';
import { escapeRegex } from '../utils/regex';

/** Colunas fixas. Os nomes casam com o que o importador reconhece, para o arquivo voltar. */
const COLUNAS_BASE = ['email', 'nome', 'empresa', 'telefone', 'situacao', 'criado em'] as const;

/** Rótulos da situação — o arquivo é lido por gente. */
const SITUACAO: Record<IContact['status'], string> = {
  active: 'ativo',
  unsubscribed: 'descadastrado',
  bounced: 'bloqueado por bounce',
};

/**
 * Teto de chaves de metadata no cabeçalho.
 *
 * Uma base importada de várias origens pode ter dezenas de colunas extras diferentes.
 * Sem teto, o cabeçalho cresceria a ponto de o arquivo ficar impraticável de abrir.
 */
const MAX_COLUNAS_METADATA = 40;

export interface ExportFilters {
  search?: string;
  listId?: string;
  status?: IContact['status'];
  delivery?: 'delivered' | 'never' | 'undeliverable';
}

export class ContactExportService {
  /** Monta o filtro do Mongo. Mesma tradução usada pela listagem da tela. */
  private buildQuery(filtros: ExportFilters): Record<string, unknown> {
    const query: Record<string, unknown> = {};

    if (filtros.search) {
      const rx = escapeRegex(filtros.search);
      query.$or = [
        { email: { $regex: rx, $options: 'i' } },
        { name: { $regex: rx, $options: 'i' } },
        { company: { $regex: rx, $options: 'i' } },
      ];
    }
    // ObjectId, não string: o `find()` converte sozinho pelo schema, mas o `aggregate()`
    // NÃO — e é ele que descobre as colunas extras. Com uma string, aquela consulta não
    // casava com nada e o arquivo saía SEM as colunas de metadata, sem erro nenhum.
    if (filtros.listId) query.lists = new Types.ObjectId(filtros.listId);
    if (filtros.status) query.status = filtros.status;

    if (filtros.delivery === 'delivered') query.lastDeliveredAt = { $ne: null };
    else if (filtros.delivery === 'never') query.lastDeliveredAt = null;
    else if (filtros.delivery === 'undeliverable') query.status = 'bounced';

    return query;
  }

  /**
   * Descobre as colunas extras (metadata) presentes no recorte exportado.
   *
   * Custa uma varredura a mais, mas é o que permite o arquivo exportado ser
   * REIMPORTADO sem perder dado: o importador transforma coluna desconhecida em
   * metadata, então exportar tudo numa coluna só quebraria a ida e volta.
   */
  private async descobrirColunasExtras(query: Record<string, unknown>): Promise<string[]> {
    const resultado = await Contact.aggregate<{ _id: string }>([
      { $match: query },
      { $project: { chaves: { $objectToArray: { $ifNull: ['$metadata', {}] } } } },
      { $unwind: '$chaves' },
      { $group: { _id: '$chaves.k' } },
      { $sort: { _id: 1 } },
      { $limit: MAX_COLUNAS_METADATA },
    ]);
    // Descarta chave que colida com uma coluna fixa: duas colunas de mesmo nome no
    // cabeçalho deixam o CSV ambíguo para quem for lê-lo depois.
    const base = new Set<string>(COLUNAS_BASE);
    return resultado.map((r) => r._id).filter((k) => !!k && !base.has(k));
  }

  /** Nome do arquivo: usa o nome da lista quando a exportação é de uma lista só. */
  private async nomeDoArquivo(listId?: string): Promise<string> {
    if (!listId) return safeFileName('contatos', 'todos');
    const lista = await List.findById(listId).select('name').lean();
    if (!lista) throw new NotFoundError('Lista não encontrada.');
    return safeFileName('contatos', lista.name);
  }

  /**
   * Escreve o CSV na resposta enquanto lê do banco.
   *
   * Recebe o `res` em vez de devolver um buffer — é o que mantém o pico de memória
   * constante, independente de quantos contatos o filtro alcança.
   */
  async streamCsv(res: Response, filtros: ExportFilters = {}): Promise<{ linhas: number }> {
    // A consulta sai escopada pelo cliente (plugin tenantScope): não há como exportar
    // a base de outro cliente, mesmo passando o id da lista dele.
    const query = this.buildQuery(filtros);
    const nomeArquivo = await this.nomeDoArquivo(filtros.listId);
    const extras = await this.descobrirColunasExtras(query);

    startCsvDownload(res, nomeArquivo, [...COLUNAS_BASE, ...extras]);

    let linhas = 0;
    const cursor = Contact.find(query)
      .select('email name company phone status createdAt metadata')
      .sort({ createdAt: -1 })
      .lean<IContact>()
      .cursor();

    try {
      for await (const c of cursor) {
        linhas++;
        // .lean() ignora os getters do schema, então o telefone vem cifrado do banco.
        const metadata = (c.metadata ?? {}) as unknown as Record<string, string>;
        await writeCsvLine(
          res,
          csvRow([
            c.email,
            c.name,
            c.company,
            decrypt(c.phone),
            SITUACAO[c.status] ?? c.status,
            csvDate(c.createdAt),
            ...extras.map((k) => metadata[k] ?? ''),
          ])
        );
      }
    } finally {
      await cursor.close();
    }

    res.end();
    return { linhas };
  }
}

export default new ContactExportService();
