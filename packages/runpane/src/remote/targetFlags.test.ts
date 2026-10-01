import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRunpaneArgs, takesDaemonTarget } from '../commands';

describe('--host / --thread parsing', () => {
  it('accepts the target before the command, like ssh host cmd', () => {
    const parsed = parseRunpaneArgs(['--host', 'rp-b', 'panels', 'list', '--json']);
    assert.equal(parsed.command, 'panels list');
    assert.equal(parsed.host, 'rp-b');
    assert.equal(parsed.json, true);
  });

  it('accepts the target after the command', () => {
    const parsed = parseRunpaneArgs(['panels', 'submit', '--panel', 'orchestrator', '--text', 'hi', '--thread', 'b-session', '--yes']);
    assert.equal(parsed.command, 'panels submit');
    assert.equal(parsed.thread, 'b-session');
    assert.equal(parsed.panelId, 'orchestrator');
  });

  it('keeps --host out of commands that do not call a daemon', () => {
    assert.throws(() => parseRunpaneArgs(['--host', 'rp-b', 'version']), /Unknown option for version: --host/);
    assert.equal(takesDaemonTarget('panels list'), true);
    assert.equal(takesDaemonTarget('doctor'), false);
  });

  it('points cloud safe-to-stop at --host (it asks a daemon), but not the rest of runpane cloud', () => {
    const parsed = parseRunpaneArgs(['cloud', 'safe-to-stop', '--host', 'rp-b', '--dry-run', '--json']);
    assert.equal(parsed.command, 'cloud safe-to-stop');
    assert.equal(parsed.host, 'rp-b');
    assert.equal(takesDaemonTarget('cloud safe-to-stop'), true);
  });
});
