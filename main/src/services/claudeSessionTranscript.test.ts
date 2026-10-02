import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findClaudeSessionTranscript } from './claudeSessionTranscript';

const SESSION_ID = '12345678-1234-4234-9234-123456789012';

describe('Claude Session transcript discovery', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-claude-transcript-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeTranscript(project: string, contents: string): Promise<string> {
    const directory = path.join(root, 'projects', project);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${SESSION_ID}.jsonl`);
    await fs.writeFile(file, contents);
    return file;
  }

  it('returns no transcript before the first persisted conversation', async () => {
    expect(findClaudeSessionTranscript(SESSION_ID, root)).toBeUndefined();
    await writeTranscript('-old-pane-directory', '');
    expect(findClaudeSessionTranscript(SESSION_ID, root)).toBeUndefined();
    expect(findClaudeSessionTranscript('../outside', root)).toBeUndefined();
  });

  it('finds the original transcript across source directories without moving it', async () => {
    const content = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } }) + '\n';
    const original = await writeTranscript('-old-pane-directory', content);
    await fs.mkdir(path.join(root, 'projects', '-new-session-directory'), { recursive: true });
    expect(findClaudeSessionTranscript(SESSION_ID, root)).toBe(original);
    await expect(fs.readFile(original, 'utf8')).resolves.toBe(content);
    await expect(fs.readdir(path.join(root, 'projects', '-new-session-directory'))).resolves.toEqual([]);
  });

  it('refuses ambiguous duplicate transcripts instead of choosing a conversation', async () => {
    await writeTranscript('-old-pane-directory', 'first transcript\n');
    await writeTranscript('-another-directory', 'second transcript\n');
    expect(() => findClaudeSessionTranscript(SESSION_ID, root)).toThrow('Multiple Claude transcripts found');
  });
});
