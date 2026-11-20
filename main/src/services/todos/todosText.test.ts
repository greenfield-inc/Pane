import { describe, expect, it } from 'vitest';
import { withTodosText } from '../../../../shared/todosText';

describe('withTodosText (T-39)', () => {
  const marked = [
    'Intro line.',
    '',
    '<!-- pane:todos -->',
    '## To-dos',
    'Run `runpane todos list`.',
    '<!-- /pane:todos -->',
    '',
    'Archive the Pane.<!-- pane:todos --> For a to-do, `runpane todos archive T-n`.<!-- /pane:todos --> Then stop.',
    '',
  ].join('\n');

  it('keeps the text as written, without its markers, while To-dos is on', () => {
    expect(withTodosText(marked, true)).toBe([
      'Intro line.', '', '## To-dos', 'Run `runpane todos list`.', '',
      'Archive the Pane. For a to-do, `runpane todos archive T-n`. Then stop.', '',
    ].join('\n'));
  });

  it('drops every marked part while To-dos is off', () => {
    expect(withTodosText(marked, false)).toBe(['Intro line.', '', 'Archive the Pane. Then stop.', ''].join('\n'));
  });

  it('leaves text without markers alone', () => {
    expect(withTodosText('a\n\n\nb', false)).toBe('a\n\n\nb');
  });
});
