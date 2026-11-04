import { randomUUID } from 'crypto';
import { expect, it } from 'vitest';
import { databaseService } from '../database';
import { panelManager } from '../panelManager';
import type { TerminalPanelState } from '../../../../shared/types/panels';

it('adopts a fork atomically as both the Chat owner and the existing terminal resume identity', async () => {
  const id = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: process.cwd(), project_id: null, tool_type: 'none' });
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'codex', agentSessionId: 'original' } });
  panelManager.commitAgentChat(panel.id, {
    conversation: { panelId: panel.id, workspaceId: id, provider: 'codex', nativeSessionId: 'fork', generation: 2, active: 'stopped', preferred: 'chat' },
    launch: { command: 'codex', cwd: process.cwd(), executable: 'codex', version: 'available', shellType: 'bash', strictMcpConfig: false, settingsFile: '', journalFile: '' },
    processes: { terminal: [], chat: [] },
  });
  // SAFETY: This test creates and retrieves a terminal panel through the public host API.
  const saved = panelManager.getPanel(panel.id)!.state.customState as TerminalPanelState;
  expect(saved.agentSessionId).toBe('fork');
  expect(saved.agentChat?.conversation.nativeSessionId).toBe('fork');
  expect(saved.agentChat?.conversation.panelId).toBe(panel.id);
});
