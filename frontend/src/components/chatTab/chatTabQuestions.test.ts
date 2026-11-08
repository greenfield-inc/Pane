import { describe, expect, it } from 'vitest';
import { questionAnswer, questionFields } from '../../../../shared/chatTabQuestions';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';

describe('question form fields', () => {
  it('reads Claude AskUserQuestion forms: single and multiple choice, each with an optional own answer', () => {
    const schema: JsonValue = {
      type: 'object',
      properties: {
        question_0: { type: 'string', title: 'Colour', description: 'Which colour?', oneOf: [{ const: 'Red', title: 'Red', description: 'Warm' }, { const: 'Blue', title: 'Blue' }] },
        question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer (optional).' },
        question_1: { type: 'array', title: 'Sizes', items: { anyOf: [{ const: 'S', title: 'Small' }, { const: 'L', title: 'Large' }] } },
      },
    };
    expect(questionFields(schema)).toEqual([
      { key: 'question_0', kind: 'single', title: 'Colour', description: 'Which colour?', choices: [{ value: 'Red', title: 'Red', description: 'Warm' }, { value: 'Blue', title: 'Blue' }] },
      { key: 'question_0_custom', kind: 'text', title: 'Other', description: 'Type your own answer (optional).' },
      { key: 'question_1', kind: 'multiple', title: 'Sizes', choices: [{ value: 'S', title: 'Small' }, { value: 'L', title: 'Large' }] },
    ]);
  });

  it('reads plain enums, booleans and numbers, and ignores what it cannot show', () => {
    expect(questionFields({ properties: {
      mode: { type: 'string', enum: ['a', 'b'] },
      ok: { type: 'boolean', title: 'Proceed?' },
      count: { type: 'integer' },
      nested: { type: 'object' },
    } })).toEqual([
      { key: 'mode', kind: 'single', title: 'mode', choices: [{ value: 'a', title: 'a' }, { value: 'b', title: 'b' }] },
      { key: 'ok', kind: 'boolean', title: 'Proceed?' },
      { key: 'count', kind: 'number', title: 'count' },
    ]);
    expect(questionFields('nonsense')).toEqual([]);
  });

  it('has no answer until the person chooses or types something', () => {
    const fields = questionFields({ type: 'object', properties: { color: { type: 'string', oneOf: [{ const: 'Red' }, { const: 'Blue' }] }, note: { type: 'string' } } });
    expect(questionAnswer(fields, {})).toBeUndefined();
    expect(questionAnswer(fields, { note: '' })).toBeUndefined();
    expect(questionAnswer(fields, { color: 'Blue', note: '' })).toEqual({ color: 'Blue' });
    // An unticked checkbox is an answer of its own.
    expect(questionAnswer(questionFields({ type: 'object', properties: { ok: { type: 'boolean' } } }), {})).toEqual({});
  });
});
