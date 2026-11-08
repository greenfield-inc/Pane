import { describe, expect, it } from 'vitest';
import { answeredFields, questionAnswer, questionFields, questionSteps, steppedAnswer, stepSummary, unshownRequiredFields } from '../../../../shared/chatTabQuestions';
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

describe('one question at a time (D-230)', () => {
  const schema: JsonValue = {
    type: 'object',
    properties: {
      question_0: { type: 'string', title: '#1491 P1', description: 'Start the agent review?', oneOf: [{ const: 'Ready', title: 'Ready: start agent review' }, { const: 'Wait', title: 'Wait for plan v9' }] },
      question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer (optional).' },
      question_1: { type: 'string', title: 'Versioning', oneOf: [{ const: 'All', title: 'Take all four' }, { const: 'Some', title: 'Change some' }] },
      question_1_custom: { type: 'string', title: 'Other' },
    },
  };
  const fields = questionFields(schema);

  it('groups each choice with the Other box after it', () => {
    expect(questionSteps(fields).map(step => step.map(field => field.key))).toEqual([['question_0', 'question_0_custom'], ['question_1', 'question_1_custom']]);
  });

  it('asks independent questions one at a time, choice or not (review F-4)', () => {
    const keys = (schema: JsonValue) => questionSteps(questionFields(schema)).map(step => step.map(field => field.key));
    // A form with no choices: a project name, then a retention period.
    expect(keys({ required: ['name', 'days'], properties: { name: { type: 'string', title: 'Project name' }, days: { type: 'integer', title: 'Keep logs for (days)' } } })).toEqual([['name'], ['days']]);
    expect(keys({ properties: { why: { type: 'string' }, pick: { type: 'string', enum: ['a'] } } })).toEqual([['why'], ['pick']]);
    // A required text question after a choice is its own question, not the choice's Other box.
    expect(keys({ required: ['pick', 'reason'], properties: { pick: { type: 'string', enum: ['a', 'b'] }, reason: { type: 'string', title: 'Why?' } } })).toEqual([['pick'], ['reason']]);
    // An optional box titled Other right after a choice stays with it, whatever its key.
    expect(keys({ properties: { pick: { type: 'string', enum: ['a'] }, note: { type: 'string', title: 'Other' }, flag: { type: 'boolean', title: 'Notify me' } } })).toEqual([['pick', 'note'], ['flag']]);
    // A companion keyed after its choice stays with it, wherever its title says.
    expect(keys({ properties: { colour: { type: 'string', enum: ['red'] }, colour_other: { type: 'string', title: 'Something else' } } })).toEqual([['colour', 'colour_other']]);
  });

  it('sums a step up for the review: the pick, the note, or skipped', () => {
    const [first, second] = questionSteps(fields);
    expect(stepSummary(first, { question_0: 'Ready', question_0_custom: 'after lunch' })).toBe('Ready: start agent review · after lunch');
    expect(stepSummary(first, { question_0_custom: 'Do it Friday' })).toBe('Do it Friday');
    expect(stepSummary(second, {})).toBeUndefined();
  });

  it('answers only the questions given something, and nothing when every one is skipped', () => {
    const steps = questionSteps(fields);
    expect(questionAnswer(answeredFields(steps, new Set([1])), { question_0: 'Ready', question_1: 'All' })).toEqual({ question_0: 'Ready' });
    expect(steppedAnswer(steps, { question_1: 'All' })).toEqual({ question_1: 'All' });
    expect(steppedAnswer(steps, {})).toBeUndefined();
    const required = questionSteps(questionFields({ required: ['a', 'b'], properties: { a: { type: 'string', enum: ['x'] }, b: { type: 'string', enum: ['y'] } } }));
    expect(steppedAnswer(required, { b: 'y' })).toEqual({ b: 'y' });
  });
});
