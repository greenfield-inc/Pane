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

/** What every field has, whatever its kind. */
type QuestionFieldBase = Pick<QuestionField, 'key' | 'title' | 'description' | 'required'>;

/** The fields Pane can show for a requested schema, in order. Fields it cannot show are left out. */
export function questionFields(schema: JsonValue): QuestionField[] {
  const decoded = decodeOptionalBoundary(schema, form);
  const required = new Set(decoded?.required);
  return Object.entries(decoded?.properties ?? {}).flatMap(([key, value]): QuestionField[] => {
    const field = decodeOptionalBoundary(value, property);
    if (!field) return [];
    const title = field.title ?? key;
    const base: QuestionFieldBase = { key, title, required: required.has(key) };
    if (field.description) base.description = field.description;
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
 * Required fields Pane cannot show (an object, say), by title. A form with any can only be
 * skipped here: an Answer without them would send the agent invalid content.
 */
export function unshownRequiredFields(schema: JsonValue): string[] {
  const decoded = decodeOptionalBoundary(schema, form);
  const shown = new Set(questionFields(schema).map(field => field.key));
  return (decoded?.required ?? []).filter(key => !shown.has(key)).map(key => {
    const title = decodeOptionalBoundary(decoded?.properties[key] ?? null, property)?.title;
    return title ?? key;
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

/**
 * The form as questions asked one at a time (D-230): every field is a question of its own,
 * except a choice's companion box (Claude's optional "Other"), which stays with its choice.
 * A companion is keyed after the choice (`question_0_custom`, `pick_other`), or is an optional
 * text field titled "Other" right after it (review F-4).
 */
export function questionSteps(fields: readonly QuestionField[]): QuestionField[][] {
  const steps: QuestionField[][] = [];
  for (const field of fields) {
    const current = steps.at(-1);
    const choice = current?.[0];
    if (current && choice && isCompanion(field, choice)) current.push(field);
    else steps.push([field]);
  }
  return steps;
}

function isCompanion(field: QuestionField, choice: QuestionField): boolean {
  if (choice.kind !== 'single' && choice.kind !== 'multiple') return false;
  if (field.kind !== 'text') return false;
  if (field.key === `${choice.key}_custom` || field.key === `${choice.key}_other`) return true;
  return !field.required && /^other\b/i.test(field.title.trim());
}

/** What was given for one question, for the review before Answer: "Ready · after lunch", or undefined when nothing was. */
export function stepSummary(step: readonly QuestionField[], values: Readonly<Record<string, JsonValue>>): string | undefined {
  const parts = step.flatMap(field => {
    const value = values[field.key];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return [];
    if (field.kind === 'single' || field.kind === 'multiple') {
      const picked = Array.isArray(value) ? value : [value];
      return [picked.map(entry => field.choices.find(choice => choice.value === entry)?.title ?? String(entry)).join(', ')];
    }
    if (field.kind === 'boolean') return value === true ? [field.title] : [];
    return [String(value).trim()].filter(Boolean);
  });
  return parts.length ? parts.join(' · ') : undefined;
}

/** The fields of the questions the person did not skip, to answer with. */
export function answeredFields(steps: readonly QuestionField[][], skipped: ReadonlySet<number>): QuestionField[] {
  return steps.flatMap((step, index) => skipped.has(index) ? [] : step);
}

/**
 * The answer to a form taken one question at a time: the questions given something, each
 * with its fields; a question with nothing given is skipped, even a required one. Undefined
 * while nothing at all is given, since an empty answer tells the agent nothing (Skip declines).
 */
export function steppedAnswer(steps: readonly QuestionField[][], values: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> | undefined {
  const skipped = new Set(steps.flatMap((step, index) => stepSummary(step, values) ? [] : [index]));
  if (skipped.size === steps.length) return undefined;
  return questionAnswer(answeredFields(steps, skipped), values);
}
