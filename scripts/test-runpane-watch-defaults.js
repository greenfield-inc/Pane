const assert = require('node:assert/strict');
const { parseRunpaneArgs } = require('../packages/runpane/dist/commands.js');
const { RUNPANE_CONTRACT } = require('../packages/runpane/dist/generated/contract.js');
for (const flag of ['--present', '--profile']) {
  assert.ok(!RUNPANE_CONTRACT.agentContext.commands.watch.arguments.some(argument => argument.name === flag));
}
const follow = parseRunpaneArgs(['watch', '--follow']);
assert.equal(follow.settleMs, 180000);
assert.equal(follow.blockedSettleMs, 30000);
assert.equal(follow.minIntervalMs, 600000);
assert.equal(follow.idleAfterMs, 600000);
assert.equal(follow.expireAfterMs, 10800000);
assert.equal(follow.heartbeatSeconds, 0);
assert.equal(follow.idleBackoff, true);
assert.ok(follow.watchKinds.includes('agent.report'));

// Individual overrides work before or after --follow, including disabled timers.
for (const flags of [
  ['--follow', '--ready-settle', '5s', '--blocked-settle', '2s', '--min-interval', '1m', '--idle-after', '20m', '--expire-after', 'off', '--heartbeat', '30s'],
  ['--ready-settle', '5s', '--blocked-settle', '2s', '--min-interval', '1m', '--idle-after', '20m', '--expire-after', 'off', '--heartbeat', '30s', '--follow'],
]) {
  const overridden = parseRunpaneArgs(['watch', ...flags]);
  assert.equal(overridden.settleMs, 5000);
  assert.equal(overridden.blockedSettleMs, 2000);
  assert.equal(overridden.minIntervalMs, 60000);
  assert.equal(overridden.idleAfterMs, 1200000);
  assert.equal(overridden.expireAfterMs, 0);
  assert.equal(overridden.heartbeatSeconds, 30);
  assert.equal(overridden.idleBackoff, true);
}
const disabled = parseRunpaneArgs(['watch', '--follow', '--ready-settle', '0', '--blocked-settle', 'off', '--min-interval', '0', '--idle-after', '0']);
assert.equal(disabled.settleMs, 0);
assert.equal(disabled.blockedSettleMs, 0);
assert.equal(disabled.minIntervalMs, 0);
assert.equal(disabled.idleAfterMs, 0);

// Single-event waits keep immediate semantics, even with a durable named cursor.
for (const flags of [[], ['--as', 'waiter'], ['--since', '1', '--epoch', 'e']]) {
  const untilEvent = parseRunpaneArgs(['watch', '--until-event', ...flags]);
  assert.deepEqual(untilEvent.watchKinds, ['agent.report', 'agent.blocked', 'panel.exited', 'pane.gone']);
  assert.equal(untilEvent.settleMs, undefined);
  assert.equal(untilEvent.blockedSettleMs, undefined);
  assert.equal(untilEvent.minIntervalMs, undefined);
  assert.equal(untilEvent.expireAfterMs, undefined);
  assert.ok(!untilEvent.idleBackoff);
}
const replay = parseRunpaneArgs(['watch', '--follow', '--since', '1', '--epoch', 'e']);
assert.equal(replay.settleMs, 0);
assert.equal(replay.blockedSettleMs, 0);
assert.equal(replay.minIntervalMs, 0);
assert.equal(replay.idleBackoff, false);

for (const flag of ['--present', '--present=true', '--profile', '--profile=present', '--profile=unattended']) {
  for (const mode of [[], ['--follow'], ['--until-event']]) {
    assert.throws(() => parseRunpaneArgs(['watch', ...mode, flag]), /was removed.*Use --follow.*--ready-settle.*--blocked-settle.*--min-interval/);
  }
}
for (const flag of ['--ready-settle', '--blocked-settle', '--min-interval', '--expire-after']) {
  assert.throws(() => parseRunpaneArgs(['watch', '--until-event', flag, '1s']), /require.*--follow/);
}
assert.equal(parseRunpaneArgs(['watch', '--until-event', '--timeout-ms', '30s']).timeoutMs, 30000);
assert.equal(parseRunpaneArgs(['watch', '--timeout-ms', 'off']).timeoutMs, 0);
assert.throws(() => parseRunpaneArgs(['watch', '--until-event', '--timeout-ms', 'off']), /greater than 0/);
assert.throws(() => parseRunpaneArgs(['watch', '--epoch', 'e']), /requires --since/);
assert.throws(() => parseRunpaneArgs(['watch', '--as', 'x', '--since', '0', '--epoch', 'e']), /cannot be combined with --as/);
console.log('watch defaults passed');
