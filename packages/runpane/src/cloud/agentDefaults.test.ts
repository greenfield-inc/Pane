import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCloudArgs } from './args';
import { runCloudCommand } from './commands';
import { createTestHarness, type TestHarness } from './__tests__/fakes';

// `runpane cloud agent-defaults`: the user's Claude model for every Session lives in settings.json
// (agentDefaults.claudeModel) and reaches each Session's daemon (runpane:cloud:agent-defaults) on new,
// wake, set/unset and push. Pane ships none: unset means Claude Code's own default.

const OPUS = 'claude-opus-5-5';

async function run(harness: TestHarness, argv: string[]): Promise<number> {
  return runCloudCommand(parseCloudArgs(argv), harness.deps);
}

async function newHost(harness: TestHarness): Promise<string> {
  assert.equal(await run(harness, ['new', '--name-prefix', 'rp-test', '--no-import', '--yes', '--json']), 0);
  const created: { host: { hostname: string } } = JSON.parse(harness.out[harness.out.length - 1] ?? '{}');
  return created.host.hostname;
}

/** The fields these tests read from `new`, `wake` and `agent-defaults` JSON output. */
interface DefaultsJson {
  ok?: boolean;
  defaults?: { claudeModel?: string };
  agentDefaults?: { host: string; pushed: boolean; claudeModel?: { inSettings: string | null; outcome: string }; reason?: string } | null;
}

function lastJson(harness: TestHarness): DefaultsJson {
  return JSON.parse(harness.out[harness.out.length - 1] ?? '{}');
}

test('nothing is configured or pushed by default: Claude Code keeps its own default', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  assert.equal(lastJson(harness).agentDefaults, null);
  assert.ok(!harness.world.calls.some((call) => call.includes('runpane:cloud:agent-defaults')));
  assert.equal(harness.world.agentDefaults.has(hostname), false);

  assert.equal(await run(harness, ['agent-defaults', '--json']), 0);
  assert.deepEqual(lastJson(harness).defaults, {});
  assert.equal(await run(harness, ['agent-defaults']), 0);
  assert.deepEqual(harness.out.slice(-1), ["claude-model: unset (Claude Code's own default)"]);
});

test('set saves the model in settings and pushes it to every awake Session', async () => {
  const harness = await createTestHarness();
  const first = await newHost(harness);
  const second = await newHost(harness);
  harness.world.agentNotesDown.add(second);

  assert.equal(await run(harness, ['agent-defaults', 'set', 'claude-model', ` ${OPUS} `]), 0);
  assert.deepEqual((await harness.deps.store.readSettings()).agentDefaults, { claudeModel: OPUS });
  assert.deepEqual(harness.world.agentDefaults.get(first), { claudeModel: OPUS });
  assert.equal(harness.world.agentDefaults.has(second), false);
  assert.ok(harness.out.some((line) => line === `  ${first}: Claude model ${OPUS} (set)`));
  assert.ok(harness.out.some((line) => line.includes(`${second}: not updated (unreachable (asleep?`)));
});

test('new hands a fresh Session the configured model', async () => {
  const harness = await createTestHarness();
  await harness.deps.store.writeSettings({ agentDefaults: { claudeModel: OPUS } });
  const hostname = await newHost(harness);
  assert.deepEqual(harness.world.agentDefaults.get(hostname), { claudeModel: OPUS });
  assert.deepEqual(lastJson(harness).agentDefaults, {
    host: hostname,
    pushed: true,
    claudeModel: { inSettings: OPUS, outcome: 'set' },
    changedFiles: ['/home/user/.claude/settings.json'],
  });
});

test('a Session that slept through unset gets it when it wakes', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  assert.equal(await run(harness, ['agent-defaults', 'set', 'claude-model', OPUS]), 0);
  assert.equal(await run(harness, ['stop', hostname, '--yes', '--json']), 0);

  harness.world.agentNotesDown.add(hostname);
  assert.equal(await run(harness, ['agent-defaults', 'unset', 'claude-model']), 0);
  assert.deepEqual((await harness.deps.store.readSettings()).agentDefaults, {});
  assert.deepEqual(harness.world.agentDefaults.get(hostname), { claudeModel: OPUS });

  harness.world.agentNotesDown.delete(hostname);
  assert.equal(await run(harness, ['wake', hostname, '--json']), 0);
  assert.equal(lastJson(harness).agentDefaults?.pushed, true);
  assert.deepEqual(harness.world.agentDefaults.get(hostname), {});
});

test('push names one Session and fails when it is not updated', async () => {
  const harness = await createTestHarness();
  const hostname = await newHost(harness);
  await harness.deps.store.writeSettings({ agentDefaults: { claudeModel: OPUS } });
  assert.equal(await run(harness, ['agent-defaults', 'push', hostname, '--json']), 0);
  assert.equal(lastJson(harness).ok, true);
  assert.deepEqual(harness.world.agentDefaults.get(hostname), { claudeModel: OPUS });

  harness.world.agentNotesDown.add(hostname);
  assert.equal(await run(harness, ['agent-defaults', 'push', hostname]), 1);
});

test('agent-defaults refuses bad input without changing settings', async () => {
  const harness = await createTestHarness();
  await assert.rejects(run(harness, ['agent-defaults', 'set', 'claude-model', 'claude opus']), /Not a Claude model id/u);
  await assert.rejects(run(harness, ['agent-defaults', 'set', 'claude-model']), /Usage: runpane cloud agent-defaults set claude-model <model>/u);
  await assert.rejects(run(harness, ['agent-defaults', 'set', 'codex-model', 'x']), /Unknown agent default: codex-model/u);
  await assert.rejects(run(harness, ['agent-defaults', 'unset']), /Usage/u);
  await assert.rejects(run(harness, ['agent-defaults', 'push', '--no-push']), /--no-push goes with set and unset/u);
  await assert.rejects(run(harness, ['agent-defaults', 'list', 'x']), /Usage/u);
  await assert.rejects(run(harness, ['agent-defaults', 'frob']), /Unknown agent-defaults command/u);
  assert.equal((await harness.deps.store.readSettings()).agentDefaults, undefined);
});
