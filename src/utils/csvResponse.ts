/**
 * Escrita de CSV direto na resposta HTTP, a partir de um cursor, sem montar o arquivo
 * em memória.
 */
import type { Response } from 'express';

/** Ponto e vírgula é o que o Excel em português espera. */
const DELIM = ';';

export function csvCell(valor: unknown): string {
  if (valor === null || valor === undefined) return '""';
  return `"${String(valor).replace(/"/g, '""')}"`;
}

export function csvDate(valor: Date | null | undefined): string {
  if (!valor) return '';
  return new Date(valor).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function csvRow(valores: unknown[]): string {
  return `${valores.map(csvCell).join(DELIM)}\r\n`;
}

export function startCsvDownload(res: Response, nomeArquivo: string, colunas: readonly string[]): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  res.setHeader('Cache-Control', 'no-store');
  // BOM: sem ele o Excel abre o arquivo em ANSI e estraga os acentos.
  res.write(`\uFEFF${colunas.join(DELIM)}\r\n`);
}

/** Espera o `drain`: sem isso, um cliente lento faria o arquivo inteiro acumular no buffer. */
export async function writeCsvLine(res: Response, linha: string): Promise<void> {
  if (!res.write(linha)) {
    await new Promise<void>((resolve) => res.once('drain', () => resolve()));
  }
}

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
