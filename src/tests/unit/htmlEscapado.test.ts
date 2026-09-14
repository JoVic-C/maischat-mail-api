import { describe, expect, it } from 'vitest';
import { garantirHtmlEnviavel, pareceHtmlEscapado } from '../../utils/htmlEscapado';

describe('HTML escapado no template', () => {
  it('pega o documento colado como texto', () => {
    expect(pareceHtmlEscapado('&lt;!DOCTYPE html&gt;&lt;html&gt;')).toBe(true);
    expect(pareceHtmlEscapado('&lt;html lang="pt-BR"&gt;')).toBe(true);
  });

  it('pega mesmo embrulhado nas tags que o editor visual cria', () => {
    // É assim que o contenteditable grava: uma <div> por linha colada.
    expect(pareceHtmlEscapado('<div>&lt;!DOCTYPE html&gt;</div><div>&lt;html&gt;</div>')).toBe(true);
    expect(pareceHtmlEscapado('<p><br></p>\n  <div>&lt;!doctype html&gt;</div>')).toBe(true);
  });

  it('não barra email de verdade', () => {
    expect(pareceHtmlEscapado('<!DOCTYPE html><html><body><p>Oi</p></body></html>')).toBe(false);
    expect(pareceHtmlEscapado('<h1>Olá {{name}}</h1>')).toBe(false);
    expect(pareceHtmlEscapado('')).toBe(false);
  });

  it('não barra email que mostra código de propósito', () => {
    expect(pareceHtmlEscapado('<p>Use a tag &lt;div&gt; assim:</p><pre>&lt;html&gt;</pre>')).toBe(false);
  });

  it('a recusa diz o que fazer, com código próprio para o painel', () => {
    try {
      garantirHtmlEnviavel('<div>&lt;!DOCTYPE html&gt;</div>');
      expect.unreachable('deveria ter recusado');
    } catch (err) {
      const e = err as { statusCode: number; code: string; message: string };
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe('HTML_ESCAPADO');
      expect(e.message).toMatch(/HTML avançado/);
    }
  });
});
