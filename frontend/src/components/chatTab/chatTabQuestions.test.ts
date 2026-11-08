import { describe, expect, it } from 'vitest';
import { questionAnswer, questionFields, unshownRequiredFields } from '../../../../shared/chatTabQuestions';
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
      { key: 'question_0', kind: 'single', title: 'Colour', description: 'Which colour?', required: false, choices: [{ value: 'Red', title: 'Red', description: 'Warm' }, { value: 'Blue', title: 'Blue' }] },
      { key: 'question_0_custom', kind: 'text', title: 'Other', description: 'Type your own answer (optional).', required: false },
      { key: 'question_1', kind: 'multiple', title: 'Sizes', required: false, choices: [{ value: 'S', title: 'Small' }, { value: 'L', title: 'Large' }] },
    ]);
  });

  it('reads plain enums, booleans and numbers, marks required ones, and ignores what it cannot show', () => {
    expect(questionFields({ required: ['ok'], properties: {
      mode: { type: 'string', enum: ['a', 'b'] },
      ok: { type: 'boolean', title: 'Proceed?' },
      count: { type: 'integer' },
      nested: { type: 'object' },
    } })).toEqual([
      { key: 'mode', kind: 'single', title: 'mode', required: false, choices: [{ value: 'a', title: 'a' }, { value: 'b', title: 'b' }] },
      { key: 'ok', kind: 'boolean', title: 'Proceed?', required: true },
      { key: 'count', kind: 'number', title: 'count', required: false },
    ]);
    expect(questionFields('nonsense')).toEqual([]);
  });

  it('has no answer on a choice form until the person chooses or types something', () => {
    const fields = questionFields({ type: 'object', properties: { color: { type: 'string', oneOf: [{ const: 'Red' }, { const: 'Blue' }] }, note: { type: 'string' } } });
    expect(questionAnswer(fields, {})).toBeUndefined();
    expect(questionAnswer(fields, { note: '' })).toBeUndefined();
    expect(questionAnswer(fields, { note: 'Green' })).toEqual({ note: 'Green' });
    expect(questionAnswer(fields, { color: 'Blue', note: '' })).toEqual({ color: 'Blue' });
  });

  it('answers a form with no fields, or only optional ones, as it stands', () => {
    expect(questionAnswer(questionFields({ type: 'object', properties: {} }), {})).toEqual({});
    expect(questionAnswer(questionFields({ type: 'object', properties: { note: { type: 'string' } } }), {})).toEqual({});
    expect(questionAnswer(questionFields({ type: 'object', properties: { ok: { type: 'boolean' } } }), {})).toEqual({ ok: false });
  });

  it('waits for every required field', () => {
    const fields = questionFields({ type: 'object', required: ['name', 'mode'], properties: { name: { type: 'string' }, mode: { type: 'string', enum: ['a', 'b'] }, note: { type: 'string' } } });
    expect(questionAnswer(fields, { name: 'x' })).toBeUndefined();
    expect(questionAnswer(fields, { name: 'x', mode: 'b' })).toEqual({ name: 'x', mode: 'b' });
  });

  it('names a required field Pane cannot show, so the form is skip-only', () => {
    const schema: JsonValue = { type: 'object', properties: { target: { type: 'object', title: 'Target' }, note: { type: 'string' } }, required: ['target'] };
    expect(unshownRequiredFields(schema)).toEqual(['Target']);
    expect(unshownRequiredFields({ type: 'object', properties: { target: { type: 'object' } } })).toEqual([]);
    expect(unshownRequiredFields({ type: 'object', properties: {} })).toEqual([]);
  });
});
