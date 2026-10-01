import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from '../commandRegistry';
import {
  guardrailsAgentNotes,
  normalizeGuardrails,
  portsAgentNotes,
  readGuardrails,
  registerAgentNotesHandler,
  removeMarkedBlock,
  upsertMarkedBlock,
  writeSessionAgentNotes,
} from './sessionAgentNotes';

const START = '<!-- runpane-cloud-ports:start -->';
const END = '<!-- runpane-cloud-ports:end -->';

describe('upsertMarkedBlock', () => {
  it('appends the block after existing text, separated by a blank line', () => {
    expect(upsertMarkedBlock('# Mine\n', `${START}\nnew\n${END}`, START, END)).toBe(`# Mine\n\n${START}\nnew\n${END}\n`);
  });

  it('replaces an older copy where it is and keeps the other blocks in order', () => {
    const other = '<!-- runpane-cloud-github:start -->\ngh\n<!-- runpane-cloud-github:end -->';
    const before = `# Mine\n\n${START}\nold\n${END}\n\n${other}\n`;
    expect(upsertMarkedBlock(before, `${START}\nnew\n${END}`, START, END)).toBe(`# Mine\n\n${START}\nnew\n${END}\n\n${other}\n`);
  });

  it('leaves a current block where it is, even when it is not last', () => {
    const other = '<!-- runpane-cloud-github:start -->\ngh\n<!-- runpane-cloud-github:end -->';
    const text = `${START}\nsame\n${END}\n\n${other}\n`;
    expect(upsertMarkedBlock(text, `${START}\nsame\n${END}`, START, END)).toBe(text);
  });

  it('writes just the block into an empty file', () => {
    expect(upsertMarkedBlock('', `${START}\nx\n${END}`, START, END)).toBe(`${START}\nx\n${END}\n`);
  });
});

describe('portsAgentNotes', () => {
  it('tells agents to publish with runpane port open and paste the https URL', () => {
    const notes = portsAgentNotes();
    expect(notes.startsWith(START)).toBe(true);
    expect(notes.endsWith(END)).toBe(true);
    expect(notes).toContain('runpane port open <port> --name <name>');
    expect(notes).toContain('runpane port list');
    expect(notes).toMatch(/never .*localhost/u);
  });
});

describe('writeSessionAgentNotes', () => {
  let root: string;
  let serveRecordPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notes-'));
    serveRecordPath = path.join(root, 'serve.json');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const files = () => [path.join(root, '.claude', 'CLAUDE.md'), path.join(root, '.codex', 'AGENTS.md')];

  it('does nothing off a Runpane Cloud Session', () => {
    expect(writeSessionAgentNotes({ home: root, serveRecordPath })).toEqual([]);
    for (const file of files()) expect(fs.existsSync(file)).toBe(false);
  });

  it('writes the block into Claude and Codex notes on a Session, keeping what is there', () => {
    fs.writeFileSync(serveRecordPath, '{"transport":"https","port":42137}');
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(files()[0] ?? '', '# My notes\n');

    expect(writeSessionAgentNotes({ home: root, serveRecordPath })).toEqual(files());
    const claude = fs.readFileSync(files()[0] ?? '', 'utf8');
    expect(claude.startsWith('# My notes\n\n')).toBe(true);
    expect(claude).toContain(portsAgentNotes());
    expect(fs.readFileSync(files()[1] ?? '', 'utf8')).toBe(`${portsAgentNotes()}\n`);
  });

  it('leaves files alone when the block is already current', () => {
    fs.writeFileSync(serveRecordPath, '{}');
    writeSessionAgentNotes({ home: root, serveRecordPath });
    expect(writeSessionAgentNotes({ home: root, serveRecordPath })).toEqual([]);
  });
});

const G_START = '<!-- runpane-cloud-guardrails:start -->';
const G_END = '<!-- runpane-cloud-guardrails:end -->';
const GUARDRAIL = 'Run the test suite (with its output) before you open a pull request.';

describe('removeMarkedBlock', () => {
  it('removes the block and the blank line before it, keeping text on both sides', () => {
    expect(removeMarkedBlock(`# Mine\n\n${G_START}\nx\n${G_END}\n\n# After\n`, G_START, G_END)).toBe('# Mine\n\n# After\n');
    expect(removeMarkedBlock(`# Mine\n\n${G_START}\nx\n${G_END}\n`, G_START, G_END)).toBe('# Mine\n');
    expect(removeMarkedBlock(`${G_START}\nx\n${G_END}\n`, G_START, G_END)).toBe('');
  });

  it('leaves text without the block unchanged', () => {
    expect(removeMarkedBlock('# Mine\n', G_START, G_END)).toBe('# Mine\n');
  });
});

describe('guardrails', () => {
  it('renders each guardrail as a bullet in its own marked block, and nothing for none', () => {
    const block = guardrailsAgentNotes([GUARDRAIL, 'Ask before force-pushing.']);
    expect(block?.startsWith(G_START)).toBe(true);
    expect(block?.endsWith(G_END)).toBe(true);
    expect(block).toContain(`\n- ${GUARDRAIL}\n- Ask before force-pushing.\n`);
    expect(guardrailsAgentNotes([])).toBeNull();
  });

  it('trims and dedupes, and refuses empty, multi-line or overlong lines', () => {
    expect(normalizeGuardrails(['  a ', 'a', 'b'])).toEqual(['a', 'b']);
    expect(() => normalizeGuardrails([' '])).toThrow(/empty/u);
    expect(() => normalizeGuardrails(['a\nb'])).toThrow(/single line/u);
    expect(() => normalizeGuardrails(['x'.repeat(501)])).toThrow(/500/u);
    expect(() => normalizeGuardrails([`ok ${G_END} then`])).toThrow(/comment markers/u);
    expect(() => normalizeGuardrails(['<!-- runpane-cloud-ports:start -->'])).toThrow(/comment markers/u);
    expect(() => normalizeGuardrails(Array.from({ length: 21 }, (_, i) => `rule ${i}`))).toThrow(/20/u);
  });
});

describe('runpane:cloud:agent-notes', () => {
  let root: string;
  let serveRecordPath: string;
  let registry: PaneCommandRegistry;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notes-'));
    serveRecordPath = path.join(root, 'serve.json');
    registry = new PaneCommandRegistry();
    registerAgentNotesHandler(registry, { home: root, serveRecordPath, now: () => new Date('2026-09-30T18:00:00Z') });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const claudeFile = () => path.join(root, '.claude', 'CLAUDE.md');
  const codexFile = () => path.join(root, '.codex', 'AGENTS.md');

  it('stores the guardrails and writes them into Claude and Codex notes beside the ports block', async () => {
    fs.writeFileSync(serveRecordPath, '{}');
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(claudeFile(), '# My notes\n');

    const result = await registry.invoke('runpane:cloud:agent-notes', [{ guardrails: [` ${GUARDRAIL} `] }]);

    expect(result).toEqual({ ok: true, guardrails: [GUARDRAIL], changedFiles: [claudeFile(), codexFile()] });
    for (const file of [claudeFile(), codexFile()]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain(portsAgentNotes());
      expect(text).toContain(`- ${GUARDRAIL}`);
    }
    expect(fs.readFileSync(claudeFile(), 'utf8').startsWith('# My notes\n\n')).toBe(true);
    const config = path.join(root, '.runpane-cloud', 'agent-notes.json');
    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    expect(readGuardrails(root)).toEqual([GUARDRAIL]);
  });

  it('renders the stored guardrails again at every daemon start, idempotently', async () => {
    fs.writeFileSync(serveRecordPath, '{}');
    await registry.invoke('runpane:cloud:agent-notes', [{ guardrails: [GUARDRAIL] }]);
    // An agent (or the user) wiped the notes; the next boot/wake restores them, once.
    fs.writeFileSync(claudeFile(), '# Fresh\n');
    expect(writeSessionAgentNotes({ home: root, serveRecordPath })).toEqual([claudeFile()]);
    expect(fs.readFileSync(claudeFile(), 'utf8')).toContain(`- ${GUARDRAIL}`);
    expect(writeSessionAgentNotes({ home: root, serveRecordPath })).toEqual([]);
    const text = fs.readFileSync(codexFile(), 'utf8');
    expect(text.split(G_START).length).toBe(2);
  });

  it('replaces the list, and an empty list removes the block but keeps the ports notes', async () => {
    fs.writeFileSync(serveRecordPath, '{}');
    await registry.invoke('runpane:cloud:agent-notes', [{ guardrails: ['old rule'] }]);
    await registry.invoke('runpane:cloud:agent-notes', [{ guardrails: [GUARDRAIL] }]);
    let text = fs.readFileSync(claudeFile(), 'utf8');
    expect(text).not.toContain('old rule');
    expect(text).toContain(GUARDRAIL);

    expect(await registry.invoke('runpane:cloud:agent-notes', [{ guardrails: [] }])).toMatchObject({ guardrails: [] });
    text = fs.readFileSync(claudeFile(), 'utf8');
    expect(text).not.toContain(G_START);
    expect(text).toBe(`${portsAgentNotes()}\n`);
  });

  it('answers the current list without arguments', async () => {
    fs.writeFileSync(serveRecordPath, '{}');
    await registry.invoke('runpane:cloud:agent-notes', [{ guardrails: [GUARDRAIL] }]);
    expect(await registry.invoke('runpane:cloud:agent-notes', [])).toEqual({ ok: true, guardrails: [GUARDRAIL], changedFiles: [] });
  });

  it('refuses off a Session and refuses bad input without touching anything', async () => {
    await expect(registry.invoke('runpane:cloud:agent-notes', [{ guardrails: [GUARDRAIL] }])).rejects.toMatchObject({ code: 'ERR_AGENT_NOTES_UNAVAILABLE' });
    fs.writeFileSync(serveRecordPath, '{}');
    await expect(registry.invoke('runpane:cloud:agent-notes', [{ guardrails: ['a\nb'] }])).rejects.toMatchObject({ code: 'ERR_AGENT_NOTES_INVALID' });
    await expect(registry.invoke('runpane:cloud:agent-notes', [{ guardrails: 'x' }])).rejects.toMatchObject({ code: 'ERR_AGENT_NOTES_INVALID' });
    await expect(registry.invoke('runpane:cloud:agent-notes', [{ guardrails: [`x ${G_END}`] }])).rejects.toMatchObject({ code: 'ERR_AGENT_NOTES_INVALID' });
    expect(fs.existsSync(path.join(root, '.runpane-cloud'))).toBe(false);
  });

  it('ignores a broken stored file at boot instead of failing', () => {
    fs.writeFileSync(serveRecordPath, '{}');
    fs.mkdirSync(path.join(root, '.runpane-cloud'));
    fs.writeFileSync(path.join(root, '.runpane-cloud', 'agent-notes.json'), '{not json');
    expect(writeSessionAgentNotes({ home: root, serveRecordPath })).toEqual([claudeFile(), codexFile()]);
    expect(fs.readFileSync(claudeFile(), 'utf8')).not.toContain(G_START);
  });
});
