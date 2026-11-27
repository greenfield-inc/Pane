/*
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code, commit 2808e878d), packages/shared/src/composerTrigger.test.ts.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, expect, it } from 'vitest';
import { detectComposerTrigger } from '../../../../shared/composerMentions';

describe('detectComposerTrigger', () => {
  it.each([
    ['Run /tmp/build.sh', 'Run /tmp/build.sh'.length],
    ['/etc/hosts', '/etc/hosts'.length],
    ['Use /etc/hosts now', 'Use /et'.length],
    ['cmd /foo\\bar', 'cmd /foo\\bar'.length],
    ['/Windows\\System32', '/Windows\\System32'.length],
  ])('keeps the path in %j out of the slash menu', (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it.each(['Use/review', 'https://example.com/review', 'Use /review '])('does not trigger for %j', text =>
    expect(detectComposerTrigger(text, text.length)).toBeNull());

  it.each(['$', '€', '𑿝'])('detects %s skill prefixes and their source range', prefix => {
    const text = `Use ${prefix}review`;
    expect(detectComposerTrigger(text, text.length)).toEqual({ kind: 'skill', query: 'review', rangeStart: 4, rangeEnd: text.length });
  });

  it.each(['budget $9.99', 'only $.99', 'about €20', 'raise $10k', '$1,000', '£2e6', 'raise $10k.'])('does not open the skill menu for the amount in %j', text =>
    expect(detectComposerTrigger(text, text.length)).toBeNull());

  it.each(['$', '$1password', '$2fa'])('still detects the skill prefix %j', text => {
    expect(detectComposerTrigger(text, text.length)).toMatchObject({ kind: 'skill', query: text.slice(1) });
  });
});
