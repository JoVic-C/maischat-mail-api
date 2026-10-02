import { EMAIL_RE } from './emailHygiene';

export type FormFields = Record<string, string>;

export interface ExtractedForm {
  fields: FormFields;
  honeypot: boolean;
}

const MAX_FIELDS = 100;
const MAX_VALUE_LENGTH = 1000;
const MAX_DEPTH = 6;

const HONEYPOT_KEYS = new Set(['gotcha', 'mmail_hp']);

/** Nunca guardados nem repassados ao template. */
const SENSITIVE_KEY = /(senha|password|passwd|token|secret|cartao|card|cvv|cvc)/;

/** Formato de ferramentas como o Elementor: `{ id, title, value }` por campo. */
const LEAF_VALUE_KEYS = ['value', 'raw_value', 'answer'];
const LEAF_LABEL_KEYS = ['id', 'name', 'title', 'label', 'ref'];

const NAME_KEYS = [
  'nome',
  'name',
  'nome_completo',
  'full_name',
  'fullname',
  'your_name',
  'seu_nome',
  'first_name',
  'primeiro_nome',
];

type Primitive = string | number | boolean;

function isPrimitive(value: unknown): value is Primitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export function normalizeKey(key: string): string {
  return key
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Sem tags nem caracteres de controle: o valor entra no email enviado a quem preencheu. */
export function cleanValue(value: Primitive): string {
  return String(value)
    .replace(/[\p{Cc}<>]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_VALUE_LENGTH);
}

/**
 * Achata qualquer corpo de formulário em chave → texto. Chaves completas (`contato_email`) têm
 * prioridade sobre o último segmento (`email`), para um `form.name` não tomar o lugar do campo `name`.
 */
export function extractFields(body: unknown): ExtractedForm {
  const primary = new Map<string, string>();
  const aliases = new Map<string, string>();
  let honeypot = false;

  const put = (target: Map<string, string>, rawKey: string, value: Primitive): void => {
    const key = normalizeKey(rawKey);
    if (!key) return;
    const clean = cleanValue(value);
    if (HONEYPOT_KEYS.has(key)) {
      if (clean) honeypot = true;
      return;
    }
    if (!clean || SENSITIVE_KEY.test(key) || target.has(key)) return;
    target.set(key, clean);
  };

  const visit = (value: unknown, path: string[], depth: number): void => {
    if (value === null || value === undefined || depth > MAX_DEPTH) return;

    if (isPrimitive(value) || (Array.isArray(value) && value.every(isPrimitive))) {
      if (!path.length) return;
      const text = Array.isArray(value) ? value.join(', ') : value;
      put(primary, path.join('_'), text);
      if (path.length > 1) put(aliases, path[path.length - 1], text);
      return;
    }

    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) visit(item, [...path, String(index)], depth + 1);
      return;
    }

    if (typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;

    const leafKey = LEAF_VALUE_KEYS.find((k) => isPrimitive(obj[k]));
    if (leafKey) {
      const leafValue = obj[leafKey] as Primitive;
      if (path.length) put(primary, path[path.length - 1], leafValue);
      for (const labelKey of LEAF_LABEL_KEYS) {
        const label = obj[labelKey];
        if (typeof label === 'string' && label.trim()) put(primary, label, leafValue);
      }
      return;
    }

    for (const [key, child] of Object.entries(obj)) visit(child, [...path, key], depth + 1);
  };

  visit(body, [], 0);

  const fields: FormFields = {};
  for (const [key, value] of [...primary, ...aliases]) {
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    if (!Object.hasOwn(fields, key)) fields[key] = value;
  }
  return { fields, honeypot };
}

function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** Campo configurado no painel é obedecido à risca; sem ele, procura pelo nome e depois pelo valor. */
export function pickEmail(fields: FormFields, configuredField = ''): string | null {
  if (configuredField.trim()) {
    const value = fields[normalizeKey(configuredField)];
    return value && isEmail(value) ? value.toLowerCase() : null;
  }
  const byKey = Object.entries(fields).find(([key, value]) => /(^|_)e_?mail(_|$)/.test(key) && isEmail(value));
  if (byKey) return byKey[1].toLowerCase();
  const byValue = Object.values(fields).find(isEmail);
  return byValue ? byValue.toLowerCase() : null;
}

export function pickName(fields: FormFields, configuredField = ''): string {
  if (configuredField.trim()) return fields[normalizeKey(configuredField)] ?? '';
  const key = NAME_KEYS.find((k) => fields[k]);
  return key ? fields[key] : '';
}
