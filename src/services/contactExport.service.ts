/**
 * Exportação de contatos em CSV, com os mesmos filtros da listagem. O arquivo é escrito
 * na resposta a partir de um cursor, sem carregar o resultado em memória.
 */
import type { Response } from 'express';
import { Types } from 'mongoose';
import { NotFoundError } from '../errors';
import Contact, { type IContact } from '../models/Contact';
import List from '../models/List';
import { csvDate, csvRow, safeFileName, startCsvDownload, writeCsvLine } from '../utils/csvResponse';
import { decrypt } from '../utils/fieldCrypto';
import { escapeRegex } from '../utils/regex';

/** Os nomes casam com o que o importador reconhece, para o arquivo poder voltar. */
const COLUNAS_BASE = ['email', 'nome', 'empresa', 'telefone', 'situacao', 'criado em'] as const;

const SITUACAO: Record<IContact['status'], string> = {
  active: 'ativo',
  unsubscribed: 'descadastrado',
  bounced: 'bloqueado por bounce',
};

const MAX_COLUNAS_METADATA = 40;

export interface ExportFilters {
  search?: string;
  listId?: string;
  status?: IContact['status'];
  delivery?: 'delivered' | 'never' | 'undeliverable';
}

export class ContactExportService {
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
    // ObjectId explícito: o `aggregate()` que descobre as colunas extras não faz cast pelo schema.
    if (filtros.listId) query.lists = new Types.ObjectId(filtros.listId);
    if (filtros.status) query.status = filtros.status;

    if (filtros.delivery === 'delivered') query.lastDeliveredAt = { $ne: null };
    else if (filtros.delivery === 'never') query.lastDeliveredAt = null;
    else if (filtros.delivery === 'undeliverable') query.status = 'bounced';

    return query;
  }

  /** Uma coluna por chave de metadata, para o arquivo poder ser reimportado sem perda. */
  private async descobrirColunasExtras(query: Record<string, unknown>): Promise<string[]> {
    const resultado = await Contact.aggregate<{ _id: string }>([
      { $match: query },
      { $project: { chaves: { $objectToArray: { $ifNull: ['$metadata', {}] } } } },
      { $unwind: '$chaves' },
      { $group: { _id: '$chaves.k' } },
      { $sort: { _id: 1 } },
      { $limit: MAX_COLUNAS_METADATA },
    ]);
    const base = new Set<string>(COLUNAS_BASE);
    return resultado.map((r) => r._id).filter((k) => !!k && !base.has(k));
  }

  private async nomeDoArquivo(listId?: string): Promise<string> {
    if (!listId) return safeFileName('contatos', 'todos');
    const lista = await List.findById(listId).select('name').lean();
    if (!lista) throw new NotFoundError('Lista não encontrada.');
    return safeFileName('contatos', lista.name);
  }

  async streamCsv(res: Response, filtros: ExportFilters = {}): Promise<{ linhas: number }> {
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
        // .lean() ignora os getters do schema, então o telefone vem cifrado.
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
