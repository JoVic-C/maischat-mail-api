/**
 * Escrita de CSV direto na resposta HTTP, sem montar o arquivo em memória.
 *
 * Usado por qualquer exportação que possa ser grande (envios de uma campanha,
 * contatos de uma lista). O padrão é sempre o mesmo: cabeçalho, depois uma linha por
 * documento vindo de um cursor do Mongo — o pico de memória não depende do tamanho
 * do resultado.
 */
import type { Response } from 'express';

/** Delimitador: ponto e vírgula, que é o que o Excel em português espera. */
const DELIM = ';';

/** Escapa um valor para uma célula de CSV. */
export function csvCell(valor: unknown): string {
  if (valor === null || valor === undefined) return '""';
  return `"${String(valor).replace(/"/g, '""')}"`;
}

/** Data no formato que o operador lê, não em ISO. */
export function csvDate(valor: Date | null | undefined): string {
  if (!valor) return '';
  return new Date(valor).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/** Monta uma linha completa a partir dos valores, já escapados. */
export function csvRow(valores: unknown[]): string {
  return `${valores.map(csvCell).join(DELIM)}\r\n`;
}

/**
 * Prepara a resposta para download e escreve o cabeçalho.
 *
 * Sem `Content-Length` de propósito: o tamanho só seria conhecido no fim, e esperar
 * por ele significaria montar o arquivo inteiro antes de começar a responder.
 */
export function startCsvDownload(res: Response, nomeArquivo: string, colunas: readonly string[]): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  res.setHeader('Cache-Control', 'no-store');
  // BOM: sem ele o Excel abre o arquivo em ANSI e estropia todo acento.
  res.write(`\uFEFF${colunas.join(DELIM)}\r\n`);
}

/**
 * Escreve uma linha respeitando a contrapressão.
 *
 * Sem esperar o dreno, um cliente lento faria o Node acumular o arquivo inteiro no
 * buffer do socket — exatamente o consumo de memória que o streaming existe para evitar.
 */
export async function writeCsvLine(res: Response, linha: string): Promise<void> {
  if (!res.write(linha)) {
    await new Promise<void>((resolve) => res.once('drain', () => resolve()));
  }
}

/** Nome de arquivo seguro, derivado de um texto livre (nome de lista, de campanha...). */
export function safeFileName(prefixo: string, texto: string, extensao = 'csv'): string {
  const base =
    texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .toLowerCase() || 'exportacao';
  const hoje = new Date().toISOString().slice(0, 10);
  return `${prefixo}-${base}-${hoje}.${extensao}`;
}
