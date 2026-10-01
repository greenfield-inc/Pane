import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

// `runpane cloud notes`: the user's guardrails live in settings.json and reach each Session's daemon
// (runpane:cloud:agent-notes) on new, wake, add/remove and push.

const GUARDRAIL = 'Run the test suite (with its output) before you open a pull request.';

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

async function newHost(harness: TestHarness): Promise<string> {
  assert.equal(await run(harness, ['new', '--name-prefix', 'rp-test', '--no-import', '--yes', '--json']), 0);
  const created: { host: { hostname: string } } = JSON.parse(harness.out[harness.out.length - 1] ?? '{}');
  return created.host.hostname;
}

/** The fields these tests read from `new`, `wake`, `notes` and `notes push` JSON output. */
interface NotesJson {
  ok?: boolean;
  guardrails?: string[];
  agentNotes?: { host: string; pushed: boolean; changedFiles?: string[]; reason?: string } | null;
}

function lastJson(harness: TestHarness): NotesJson {
  return JSON.parse(harness.out[harness.out.length - 1] ?? '{}');
}

test('nothing is configured or pushed by default: Pane ships no guardrails', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  assert.equal(lastJson(harness).agentNotes, null);
  assert.ok(!harness.world.calls.some((call) => call.includes('runpane:cloud:agent-notes')));
  assert.equal(harness.world.agentNotes.has(hostname), false);

  assert.equal(await run(harness, ['notes', '--json']), 0);
  assert.deepEqual(lastJson(harness).guardrails, []);
});

test('add saves the guardrail in settings and pushes it to every awake Session', async () => {
  const harness = await createTestHarness();
  const first = await newHost(harness);
  const second = await newHost(harness);
  harness.world.agentNotesDown.add(second);

  assert.equal(await run(harness, ['notes', 'add', `  ${GUARDRAIL}  `]), 0);
  assert.deepEqual((await harness.deps.store.readSettings()).agentNotes, { guardrails: [GUARDRAIL] });
  assert.deepEqual(harness.world.agentNotes.get(first), [GUARDRAIL]);
  assert.equal(harness.world.agentNotes.has(second), false);
  assert.ok(harness.out.some((line) => line.includes(`${second}: not updated (unreachable (asleep?`)));

  // Adding the same line again keeps one copy.
  assert.equal(await run(harness, ['notes', 'add', GUARDRAIL, '--no-push']), 0);
  assert.equal(await run(harness, ['notes', 'list']), 0);
  assert.deepEqual(harness.out.slice(-1), [`1. ${GUARDRAIL}`]);
});

test('new hands a fresh Session the configured guardrails', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ agentNotes: { guardrails: [GUARDRAIL] } });
  const hostname = await newHost(harness);
  assert.deepEqual(harness.world.agentNotes.get(hostname), [GUARDRAIL]);
  assert.deepEqual(lastJson(harness).agentNotes, {
    host: hostname,
    pushed: true,
    changedFiles: ['/home/user/.claude/CLAUDE.md', '/home/user/.codex/AGENTS.md'],
  });
});

test('a Session that slept through a change gets the list when it wakes; an empty list clears it', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  assert.equal(await run(harness, ['notes', 'add', GUARDRAIL]), 0);
  assert.equal(await run(harness, ['stop', hostname, '--yes', '--json']), 0);

  harness.world.agentNotesDown.add(hostname);
  assert.equal(await run(harness, ['notes', 'remove', '1']), 0);
  assert.deepEqual(harness.world.agentNotes.get(hostname), [GUARDRAIL]);

  harness.world.agentNotesDown.delete(hostname);
  assert.equal(await run(harness, ['wake', hostname, '--json']), 0);
  assert.deepEqual(lastJson(harness).agentNotes, { host: hostname, pushed: true, changedFiles: ['/home/user/.claude/CLAUDE.md', '/home/user/.codex/AGENTS.md'] });
  assert.deepEqual(harness.world.agentNotes.get(hostname), []);
});

test('push names one Session and fails when it is not updated', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  await harness.deps.store.writeSettings({ agentNotes: { guardrails: [GUARDRAIL] } });
  assert.equal(await run(harness, ['notes', 'push', hostname, '--json']), 0);
  assert.equal(lastJson(harness).ok, true);
  assert.deepEqual(harness.world.agentNotes.get(hostname), [GUARDRAIL]);

  harness.world.agentNotesDown.add(hostname);
  assert.equal(await run(harness, ['notes', 'push', hostname]), 1);
});

test('notes refuses bad input without changing settings', async () => {
  const harness = await createTestHarness();
  await assert.rejects(run(harness, ['notes', 'add', 'two\nlines']), /single line/u);
  await assert.rejects(run(harness, ['notes', 'add', ' ']), /empty/u);
  await assert.rejects(run(harness, ['notes', 'add', 'x'.repeat(501)]), /500/u);
  await assert.rejects(run(harness, ['notes', 'add', 'end <!-- runpane-cloud-guardrails:end --> here']), /comment markers/u);
  await assert.rejects(run(harness, ['notes', 'add', 'Ask', 'first']), /quote the guardrail/u);
  await assert.rejects(run(harness, ['notes', 'remove', '3']), /No guardrail "3"/u);
  await assert.rejects(run(harness, ['notes', 'push', '--no-push']), /--no-push goes with add and remove/u);
  await assert.rejects(run(harness, ['notes', 'frob']), /Unknown notes command/u);
  assert.equal((await harness.deps.store.readSettings()).agentNotes, undefined);
});
