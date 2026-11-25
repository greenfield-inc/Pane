import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readUpTo } from './boundedRead';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-bounded-read-'));
afterEach(() => { for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name)); });

describe('readUpTo', () => {
  it('reads a file at or under the limit', () => {
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, 'abcd');
    expect(readUpTo(file, 4)?.toString()).toBe('abcd');
    expect(readUpTo(file, 10)?.toString()).toBe('abcd');
  });

  it('refuses a file over the limit without reading it whole', () => {
    const file = path.join(dir, 'big.html');
    fs.writeFileSync(file, 'abcde');
    expect(readUpTo(file, 4)).toBeNull();
  });

  it('throws for a file that is not there, as fs does', () => {
    expect(() => readUpTo(path.join(dir, 'gone.html'), 4)).toThrow();
  });
});
