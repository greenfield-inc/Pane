import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { getAppDirectory } from '../../utils/appDirectory';
import {
  bracketedPaste,
  canLaunchWithPromptFile,
  claudePromptWarnings,
  filePointerPrompt,
  isLongPrompt,
  normalizePromptNewlines,
  promptFileShellWord,
  stripTrailingNewlines,
  writePromptFile,
} from './promptDelivery';

describe('prompt delivery', () => {
  it('turns CRLF and lone CR into LF and drops trailing newlines', () => {
    expect(normalizePromptNewlines('one\r\ntwo\rthree\n')).toBe('one\ntwo\nthree\n');
    expect(stripTrailingNewlines('one\ntwo\n\n\n')).toBe('one\ntwo');
  });

  it('treats multi-line or over-512-character text as long', () => {
    expect(isLongPrompt('short')).toBe(false);
    expect(isLongPrompt('x'.repeat(512))).toBe(false);
    expect(isLongPrompt('x'.repeat(513))).toBe(true);
    expect(isLongPrompt('one\ntwo')).toBe(true);
  });

  it('wraps a paste and drops paste markers from inside the text', () => {
    expect(bracketedPaste('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
    expect(bracketedPaste('a\x1b[201~b\x1b[200~c')).toBe('\x1b[200~abc\x1b[201~');
  });

  it('writes a prompt file under the Pane directory, readable only by the user', async () => {
    const file = await writePromptFile('session/1', 'line one\nline two', new Date('2026-09-27T18:00:00.123Z'));

    expect(path.dirname(file)).toBe(path.join(getAppDirectory(), 'prompts', 'session_1'));
    expect(path.basename(file)).toMatch(/^2026-09-27T18-00-00-123Z-[0-9a-f]{6}\.md$/u);
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\nline two\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(getAppDirectory(), 'prompts')).mode & 0o777).toBe(0o700);
    }
    expect(filePointerPrompt(file)).toBe(`Read and follow ${file}`);
  });

  it('builds one shell word that expands to the file, and refuses paths bash could history-expand', async () => {
    const file = await writePromptFile("it's", 'Keep $HOME, `ticks`, "quotes" and ! as text\nsecond line');
    const word = promptFileShellWord(file);

    expect(word).toBe(`"$(cat '${file.replace(/'/gu, `'\\''`)}')"`);
    expect(promptFileShellWord('/tmp/bang!/prompt.md')).toBeUndefined();
    if (process.platform !== 'win32') {
      const echoed = execFileSync('/bin/sh', ['-c', `printf '%s' ${word}`], { encoding: 'utf8' });
      expect(echoed).toBe('Keep $HOME, `ticks`, "quotes" and ! as text\nsecond line');
    }
  });

  it('reads prompt files at launch only in POSIX shells outside Windows and WSL', () => {
    expect(canLaunchWithPromptFile('zsh', false, 'darwin')).toBe(true);
    expect(canLaunchWithPromptFile('bash', false, 'linux')).toBe(true);
    expect(canLaunchWithPromptFile('bash', true, 'linux')).toBe(false);
    expect(canLaunchWithPromptFile('bash', false, 'win32')).toBe(false);
    expect(canLaunchWithPromptFile('fish', false, 'linux')).toBe(false);
    expect(canLaunchWithPromptFile('pwsh', false, 'linux')).toBe(false);
    expect(canLaunchWithPromptFile(undefined, false, 'linux')).toBe(false);
  });

  it.each([
    ['!ls', 'leading-bang-runs-shell'],
    ['  # remember this', 'leading-hash-memory'],
    ['/review', 'leading-slash-command'],
    ['@src/index.ts explain', 'leading-at-mention'],
  ])('warns about Claude\'s meaning for %j', (text, code) => {
    expect(claudePromptWarnings(text)).toEqual([{ code, message: expect.any(String) }]);
  });

  it('has no warning for ordinary text', () => {
    expect(claudePromptWarnings('Plan issue 42')).toBeUndefined();
  });
});
