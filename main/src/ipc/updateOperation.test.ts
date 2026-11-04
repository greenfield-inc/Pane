import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../shared/types/panels';
import { writeUpdateJson } from '../../../packages/runpane/src/updateOperation';
import { UpdatePanelRestorer } from '../services/updateRestoration';

interface RestoreFixture { root: string; panel?: ToolPanel; initialized: boolean; initialize: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> }
const fixture: RestoreFixture = { root: '', initialized: false, initialize: vi.fn(), verify: vi.fn() };
let restorer: UpdatePanelRestorer;
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-update-restore-'));
  fixture.initialized = false;
  fixture.panel = { id: 'panel', sessionId: 'session', type: 'terminal', title: 'Agent', state: { isActive: false, customState: { agentSessionId: 'recorded', updateResumeHold: 'operation' } }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  fixture.initialize.mockReset().mockImplementation(async () => { fixture.initialized = true; });
  fixture.verify.mockReset().mockResolvedValue({ pid: 123 });
  writeUpdateJson(path.join(fixture.root, 'updates/operation/checkpoint.json'), { bootId: 'before', panels: [{ panelId: 'panel', sessionId: 'session', resumeId: 'recorded', cwd: fixture.root, activity: 'working', priorState: { agentSessionId: 'recorded' }, eligible: true, reason: 'recorded' }] });
  restorer = new UpdatePanelRestorer(id => path.join(fixture.root, 'updates', id), 'current-boot', {
    getPanel: () => fixture.panel,
    updatePanel: async (_id, update) => { if (fixture.panel) Object.assign(fixture.panel, update); },
    isInitialized: () => fixture.initialized,
    initialize: fixture.initialize,
    verify: fixture.verify,
  });
});
afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
const restore = () => restorer.restore('operation');

describe('durable panel restoration', () => {
  it('does not report resumed before the harness confirms identity and readiness', async () => {
    let reject!: (error: Error) => void;
    fixture.verify.mockImplementation(() => new Promise((_resolve, failure) => { reject = failure; }));
    expect(await restore()).toMatchObject({ complete: false, restored: [] });
    await vi.waitFor(() => expect(fixture.verify).toHaveBeenCalledOnce());
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root, 'updates/operation/restoration.json'), 'utf8'))[0].phase).toBe('claimed');
    reject(new Error('Harness rejected the conversation'));
    await vi.waitFor(async () => expect(await restore()).toMatchObject({ complete: true, restored: [{ outcome: 'needs-attention', reason: 'Harness rejected the conversation' }] }));
  });
  it('returns durable results after helper retries without spawning or re-holding the panel', async () => {
    await restore();
    await vi.waitFor(async () => expect(await restore()).toMatchObject({ complete: true, restored: [{ outcome: 'resumed' }] }));
    const first = await restore();
    expect(await restore()).toEqual(first);
    expect(fixture.initialize).toHaveBeenCalledOnce();
    expect(fixture.panel?.state.customState).not.toHaveProperty('updateResumeHold', 'operation');
  });
  it('never replays an ambiguous launch claim after a host crash', async () => {
    writeUpdateJson(path.join(fixture.root, 'updates/operation/restoration.json'), [{ panelId: 'panel', sessionId: 'session', resumeId: 'recorded', bootId: 'previous-host', phase: 'claimed', outcome: 'pending', reason: 'launch not acknowledged' }]);
    await restore();
    await vi.waitFor(async () => expect(await restore()).toMatchObject({ complete: true, restored: [{ outcome: 'needs-attention' }] }));
    expect(fixture.initialize).not.toHaveBeenCalled();
  });
  it('does not reuse a successful launch acknowledgment from an earlier host boot', () => {
    writeUpdateJson(path.join(fixture.root, 'updates/operation/restoration.json'), [{ panelId: 'panel', sessionId: 'session', resumeId: 'recorded', bootId: 'previous-host', phase: 'finished', outcome: 'resumed', reason: 'previously verified', pid: 123 }]);
    expect(restore()).toMatchObject({ complete: true, restored: [{ outcome: 'needs-attention', reason: expect.stringContaining('restarted') }] });
    expect(fixture.initialize).not.toHaveBeenCalled();
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(restore().restored[0].outcome).toBe('needs-attention');
  });
});
