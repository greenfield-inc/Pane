import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { NativeHookJournal, recordNativeHook } from './nativeHookJournal';

describe('native lifecycle checkpoint journal', () => {
  it('accepts fresh trust navigation after the complete captured startup replies at every split', () => {
    const prefix = '\x1b]11;rgb:f9f9/fcfc/ffff\x1b\\\x1b]10;rgb:0000/0000/0000\x07\x1b[?0u\x1bP>|xterm.js(6.1.0-beta.302)\x1b\\\x1b_Gi=31;OK\x1b\\\x1b[6;18;8t\x1b[?62;4;9;22c\x1b[?1;2c';
    const dir = mkdtempSync(path.join(tmpdir(), 'pane-chat-startup-'));
    try {
      for (let split = 0; split <= prefix.length; split++) {
        const file = path.join(dir, `${split}.jsonl`);
        const journal = new NativeHookJournal(file, 'conversation-a');
        const hook = (name: string, extra = {}) => recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: name, ...extra });
        journal.input(prefix.slice(0, split));
        journal.input(prefix.slice(split));
        journal.input('\x1b[B\r');
        hook('SessionStart');
        journal.input('actual prompt\r');
        hook('UserPromptSubmit', { prompt: 'actual prompt' });
        hook('Stop', { background_tasks: [], session_crons: [] });
        expect(journal.checkpoint().ready, `split ${split}`).toBe(true);
        journal.input('\x1b[200~' + prefix + '\x1b[201~');
        expect(journal.checkpoint().ready).toBe(false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps an idle checkpoint through real xterm replies, including fragmented replies, but still blocks actual queued work', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pane-chat-protocol-'));
    const file = path.join(dir, 'events.jsonl');
    const journal = new NativeHookJournal(file, 'conversation-a');
    const hook = (name: string, extra = {}) => recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: name, ...extra });
    try {
      journal.input('\x1b[B\r'); // First-run trust choice, before SessionStart.
      hook('SessionStart');
      journal.input('Remember the marker\r');
      hook('UserPromptSubmit', { prompt: 'Remember the marker' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      journal.input('\x1b[6;18;8t\x1b[?62;4;9;22c\x1b[?1;2c\x1b[I\x1b[O');
      expect(journal.checkpoint().ready).toBe(true);
      journal.input('\x1b[?62;4;');
      expect(journal.checkpoint().ready).toBe(false);
      journal.input('9;22c');
      expect(journal.checkpoint().ready).toBe(true);
      journal.input('Next\rQueued\r\x1b[6;18;8t');
      hook('UserPromptSubmit', { prompt: 'Next' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
      hook('UserPromptSubmit', { prompt: 'Queued' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(true);
      journal.input('unsent\x1b[?1;2c');
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps queued submissions and an unfinished composer out of the transferable checkpoint', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pane-chat-queue-'));
    const file = path.join(dir, 'events.jsonl');
    const journal = new NativeHookJournal(file, 'conversation-a');
    const hook = (name: string, extra = {}) => recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: name, ...extra });
    try {
      journal.input('First\r');
      journal.input('Queued\r');
      hook('UserPromptSubmit', { prompt: 'First' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
      hook('UserPromptSubmit', { prompt: '<task-notification>Background finished</task-notification>' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
      hook('UserPromptSubmit', { prompt: 'Queued' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(true);
      journal.input('Unsubmitted draft');
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps pasted multiline drafts and keyboard navigation out of an idle handoff', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pane-chat-paste-'));
    const file = path.join(dir, 'events.jsonl');
    const journal = new NativeHookJournal(file, 'conversation-a');
    const hook = (name: string, extra = {}) => recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: name, ...extra });
    try {
      hook('SessionStart');
      hook('Stop', { background_tasks: [], session_crons: [] });
      journal.input('\x1b[200~first\rsecond\r');
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
      journal.input('\x1b[201~');
      expect(journal.checkpoint().ready).toBe(false);
      journal.input('\r');
      hook('UserPromptSubmit', { prompt: 'first\nsecond' });
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(true);
      journal.input('\x1b[A'); // History recall can populate a draft.
      hook('Stop', { background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('requires a matching structured stop, preserves busy boundaries, and excludes prompt/tool contents', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pane-chat-hooks-'));
    const file = path.join(dir, 'events.jsonl');
    try {
      const journal = new NativeHookJournal(file, 'conversation-a');
      expect(journal.checkpoint().ready).toBe(false);
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'SessionStart', cwd: '/workspace' });
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_INPUT', permission_mode: 'default' });
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'Stop', background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(true);
      journal.input('Another prompt\r');
      expect(journal.checkpoint().ready).toBe(false);
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'PermissionRequest', tool_input: { key: 'PRIVATE_TOOL' } });
      expect(journal.checkpoint().ready).toBe(false);
      recordNativeHook(file, { session_id: 'conversation-b', hook_event_name: 'Stop', background_tasks: [], session_crons: [] });
      expect(journal.checkpoint().ready).toBe(false);
      expect(readFileSync(file, 'utf8')).not.toMatch(/PRIVATE_INPUT|PRIVATE_TOOL/);
      recordNativeHook(file, { session_id: 'conversation-a', hook_event_name: 'SessionEnd' });
      expect(journal.ended()).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
