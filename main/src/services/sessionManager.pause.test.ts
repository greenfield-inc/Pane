import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database';
import { SessionManager } from './sessionManager';
import { panelManager } from '../test/setup';

describe('paused Panes across app restarts', () => {
  it('are left out of the launch Resume dialog and the restart-after-update resume, and still read as paused', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-pause-restart-'));
    const db = new DatabaseService(path.join(tempDir, 'sessions.db'));
    const manager = new SessionManager(db);
    try {
      db.initialize();
      const project = db.createProject('repo', tempDir);
      const interrupted = { agentType: 'claude', agentSessionId: '0c4c1f2e-4b1b-4e8e-9c4a-2f8f5b8a1d11', initialCommand: 'claude', wasInterrupted: true };
      const paused = { at: '2026-11-04T12:00:00.000Z', by: 'manual' };
      for (const id of ['paused-pane', 'running-pane']) {
        db.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: tempDir, project_id: project.id, tool_type: 'none' });
        db.updateSession(id, { status: 'interrupted' });
        db.createPanel({ id: `${id}:claude`, sessionId: id, type: 'terminal', title: 'Claude', state: { customState: id === 'paused-pane' ? { ...interrupted, paused } : interrupted } });
      }

      expect(manager.getResumableSessions(project.id).map(session => session.sessionId)).toEqual(['running-pane']);
      panelManager.getPanel.mockImplementation((panelId: string) => db.getPanel(panelId));
      await manager.resumeInterruptedSessions(['paused-pane']);
      expect(panelManager.updatePanel).not.toHaveBeenCalledWith('paused-pane:claude', expect.anything());
      expect(manager.getSession('paused-pane')?.paused).toEqual(paused);
      expect(manager.getSession('running-pane')?.paused).toBeUndefined();
    } finally {
      panelManager.getPanel.mockReset();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
