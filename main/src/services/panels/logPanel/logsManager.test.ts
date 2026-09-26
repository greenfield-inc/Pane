import { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../../../shared/types/panels';
import { panelManager } from '../../panelManager';
import { cleanupSessionLogs, getSessionLogs } from '../../session-logs';
import { LogsManager } from './logsManager';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupSessionLogs('script-test');
});

it('streams script output without persisting panel state for every chunk', async () => {
  const panel: ToolPanel = {
    id: 'logs-panel', sessionId: 'script-test', type: 'logs', title: 'Logs',
    state: { isActive: true, customState: {} },
    metadata: { createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), position: 0 },
  };
  vi.spyOn(panelManager, 'getPanelsForSession').mockResolvedValue([panel]);
  vi.spyOn(panelManager, 'getPanel').mockResolvedValue(panel);
  vi.spyOn(panelManager, 'setActivePanel').mockResolvedValue(undefined);
  const persist = vi.spyOn(panelManager, 'updatePanel').mockResolvedValue(undefined);
  const child = new ChildProcess();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const manager = new LogsManager(() => child);
  await manager.runScript('script-test', 'fixture-command', '/fixture');
  persist.mockClear();

  child.stdout.emit('data', Buffer.from('ready\n'));
  child.stderr.emit('data', Buffer.from('warning\n'));
  await new Promise(resolve => setImmediate(resolve));

  expect(getSessionLogs('script-test').map(entry => [entry.level, entry.message])).toEqual([
    ['info', 'ready\n'], ['error', 'warning\n'],
  ]);
  expect(persist).not.toHaveBeenCalled();
  child.emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  expect(persist).toHaveBeenCalledWith('logs-panel', expect.objectContaining({
    state: expect.objectContaining({ customState: expect.objectContaining({ isRunning: false, exitCode: 0 }) }),
  }));
});
