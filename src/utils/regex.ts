/**
 * Escapa metacaracteres de regex para uso seguro em `$regex` do Mongo.
 * Evita 500 quando o usuário digita `(`, `[`, etc., e reduz a superfície de ReDoS.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
