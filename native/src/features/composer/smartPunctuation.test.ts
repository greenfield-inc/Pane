import { describe, expect, it } from 'vitest';

import { straightenSmartPunctuation } from './smartPunctuation';

describe('straightenSmartPunctuation', () => {
  it('turns curly quotes back into the straight ones a shell reads', () => {
    expect(straightenSmartPunctuation('git commit -m “fix it” && echo ‘done’'))
      .toBe('git commit -m "fix it" && echo \'done\'');
  });

  it('keeps apostrophes straight', () => {
    expect(straightenSmartPunctuation('don’t')).toBe('don\'t');
  });

  it('turns the em dash iOS makes from two hyphens back into them', () => {
    expect(straightenSmartPunctuation('ls —all')).toBe('ls --all');
  });

  it('turns the ellipsis character back into three dots', () => {
    expect(straightenSmartPunctuation('git diff main…HEAD')).toBe('git diff main...HEAD');
  });

  it('returns plain text unchanged', () => {
    const text = 'fix the teh typo';
    expect(straightenSmartPunctuation(text)).toBe(text);
  });
});
