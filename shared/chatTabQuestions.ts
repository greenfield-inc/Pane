import { boundary, decodeOptionalBoundary, type JsonValue } from './validation/boundaryDecoder';

export interface QuestionChoice { value: string; title: string; description?: string }

/**
 * One field of an agent's question form, in the shapes ACP form elicitation allows.
 * `required` comes from the schema's `required` list.
 */
export type QuestionField =
  | { key: string; kind: 'single' | 'multiple'; title: string; description?: string; required: boolean; choices: QuestionChoice[] }
  | { key: string; kind: 'text' | 'number' | 'boolean'; title: string; description?: string; required: boolean };

const option = boundary.object({ const: boundary.string, title: boundary.optional(boundary.string), description: boundary.optional(boundary.string) });
const property = boundary.object({
  type: boundary.optional(boundary.string),
  title: boundary.optional(boundary.string),
  description: boundary.optional(boundary.string),
  oneOf: boundary.optional(boundary.array(option)),
  anyOf: boundary.optional(boundary.array(option)),
  enum: boundary.optional(boundary.array(boundary.string)),
  items: boundary.optional(boundary.object({ anyOf: boundary.optional(boundary.array(option)), oneOf: boundary.optional(boundary.array(option)), enum: boundary.optional(boundary.array(boundary.string)) })),
});
const form = boundary.object({ properties: boundary.record(boundary.json), required: boundary.optional(boundary.array(boundary.string)) });

function choices(options: Array<{ const: string; title?: string; description?: string }> | undefined, values: string[] | undefined): QuestionChoice[] | undefined {
  if (options?.length) return options.map(entry => {
    const choice: QuestionChoice = { value: entry.const, title: entry.title ?? entry.const };
    if (entry.description) choice.description = entry.description;
    return choice;
  });
  return values?.length ? values.map(value => ({ value, title: value })) : undefined;
}

/** The fields Pane can show for a requested schema, in order. Fields it cannot show are left out. */
export function questionFields(schema: JsonValue): QuestionField[] {
  const decoded = decodeOptionalBoundary(schema, form);
  const required = new Set(decoded?.required);
  return Object.entries(decoded?.properties ?? {}).flatMap(([key, value]): QuestionField[] => {
    const field = decodeOptionalBoundary(value, property);
    if (!field) return [];
    const title = field.title ?? key;
    const base = { key, title, ...(field.description ? { description: field.description } : {}), required: required.has(key) };
    if (field.type === 'array') {
      const list = choices(field.items?.anyOf ?? field.items?.oneOf, field.items?.enum);
      return list ? [{ ...base, kind: 'multiple', choices: list }] : [];
    }
    if (field.type === 'string' || field.type === undefined) {
      const list = choices(field.oneOf ?? field.anyOf, field.enum);
      if (list) return [{ ...base, kind: 'single', choices: list }];
      return field.type === 'string' ? [{ ...base, kind: 'text' }] : [];
    }
    if (field.type === 'boolean') return [{ ...base, kind: 'boolean' }];
    if (field.type === 'number' || field.type === 'integer') return [{ ...base, kind: 'number' }];
    return [];
  });
}

/**
 * The form's answer, or undefined while Answer would be incomplete. Every required
 * field needs a value, and a form with choices needs something chosen or typed:
 * Claude's AskUserQuestion marks nothing required, and an Answer with no pick tells
 * the agent nothing (Skip declines). A form with no fields answers `{}`, and an
 * untouched checkbox answers `false`.
 */
export function questionAnswer(fields: readonly QuestionField[], values: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> | undefined {
  const content: Record<string, JsonValue> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      if (field.required && field.kind !== 'boolean') return undefined;
    } else content[field.key] = value;
  }
  if (!Object.keys(content).length && fields.some(field => field.kind === 'single' || field.kind === 'multiple')) return undefined;
  for (const field of fields) if (field.kind === 'boolean' && !(field.key in content)) content[field.key] = false;
  return content;
}
