import { BadRequestError } from '../errors';

/**
 * O template guarda um email em HTML ESCAPADO — código-fonte como texto?
 *
 * Acontece quando o código de um email é colado no editor visual: o navegador o insere
 * como texto e o que fica gravado é `&lt;!DOCTYPE html&gt;…`, geralmente dentro de
 * `<div>`s ou `<p>`s que o próprio editor criou. Enviado assim, o destinatário recebe o
 * código-fonte na caixa de entrada em vez do email.
 *
 * Só conta o COMEÇO do conteúdo, ignorando as tags que o editor põe em volta: um email
 * legítimo que mostra um trecho de código (`&lt;div&gt;` num tutorial) nunca começa com
 * um doctype ou um `<html>` escapados.
 */
export function pareceHtmlEscapado(html: string): boolean {
  const inicio = html
    .slice(0, 2000)
    .replace(/^(\s*<[^>]*>)*\s*/, '') // tags de embrulho do editor: <div>, <p>, <br>...
    .toLowerCase();
  return inicio.startsWith('&lt;!doctype') || inicio.startsWith('&lt;html');
}

/** Recusa um template corrompido antes que ele seja salvo ou enviado. */
export function garantirHtmlEnviavel(html: string): void {
  if (!pareceHtmlEscapado(html)) return;
  throw new BadRequestError(
    'O conteúdo deste template está como texto, não como HTML — o destinatário receberia o código-fonte. ' +
      'Abra o template, entre no modo "HTML avançado", apague o conteúdo e cole o HTML de novo.',
    'HTML_ESCAPADO'
  );
}
