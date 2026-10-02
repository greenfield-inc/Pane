import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyManagedAgentsMdSetting,
  ensureProjectAgentContext,
  PANE_AGENT_CONTEXT_END,
  PANE_AGENT_CONTEXT_START,
} from './agentContextManager';

const tempDirs: string[] = [];

function enabledConfig() {
  return { agentContext: { managedAgentsMd: true } };
}

function disabledConfig() {
  return { agentContext: { managedAgentsMd: false } };
}

async function createTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-agent-context-'));
  tempDirs.push(dir);
  return dir;
}

describe('agentContextManager', () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('creates AGENTS.md with a managed Pane block when publishing is on', async () => {
    const projectPath = await createTempProject();

    const result = await ensureProjectAgentContext({ path: projectPath }, enabledConfig());

    expect(result.changed).toBe(true);
    expect(result.filePath).toBe(path.join(projectPath, 'AGENTS.md'));
    const content = await fs.readFile(path.join(projectPath, 'AGENTS.md'), 'utf8');
    expect(content).toContain(PANE_AGENT_CONTEXT_START);
    expect(content).toContain('npm i -g runpane');
    expect(content).toContain('npx --yes runpane@latest');
    expect(content).toContain('runpane doctor --json');
    expect(content).toContain('runpane agent-context --json');
    expect(content).toContain('claude mcp add --scope user pane -- npx --yes runpane@latest mcp');
    expect(content).toContain('[mcp_servers.pane]');
    expect(content).toContain('claude mcp list');
    expect(content).toContain('codex mcp list');
    expect(content).toContain('agent mcp list');
    expect(content).toContain('agent mcp enable pane');
    expect(content).not.toContain('Typical workflow: register the saved base repository once');
    expect(content).not.toContain('Skill routing reference:');
    expect(content).toContain(PANE_AGENT_CONTEXT_END);
  });

  it('leaves repositories untouched when the setting is absent', async () => {
    const projectPath = await createTempProject();

    const result = await ensureProjectAgentContext({ path: projectPath }, {});

    expect(result.changed).toBe(false);
    await expect(fs.access(path.join(projectPath, 'AGENTS.md'))).rejects.toThrow();
  });

  it('removes only Pane\'s section from every project when publishing turns off', async () => {
    const active = await createTempProject();
    const inactive = await createTempProject();
    await fs.writeFile(path.join(inactive, 'AGENTS.md'), '# Repo Rules\n\nKeep this line.\n', 'utf8');
    await ensureProjectAgentContext({ path: active }, enabledConfig());
    await ensureProjectAgentContext({ path: inactive }, enabledConfig());
    const projects = [{ path: active }, { path: inactive }];

    await applyManagedAgentsMdSetting(disabledConfig(), {
      all: () => projects,
      active: () => projects[0],
    });

    await expect(fs.readFile(path.join(active, 'AGENTS.md'), 'utf8')).resolves.not.toContain(PANE_AGENT_CONTEXT_START);
    const kept = await fs.readFile(path.join(inactive, 'AGENTS.md'), 'utf8');
    expect(kept).toContain('Keep this line.');
    expect(kept).not.toContain(PANE_AGENT_CONTEXT_START);
  });

  it('retries removal when a saved project becomes available again', async () => {
    const projectPath = await createTempProject();
    const offlinePath = `${projectPath}-offline`;
    await ensureProjectAgentContext({ path: projectPath }, enabledConfig());
    await fs.rename(projectPath, offlinePath);
    try {
      const projects = [{ path: projectPath }];
      expect(await applyManagedAgentsMdSetting(disabledConfig(), {
        all: () => projects,
        active: () => projects[0],
      })).toBe(false);
      await fs.rename(offlinePath, projectPath);
      expect(await applyManagedAgentsMdSetting(disabledConfig(), {
        all: () => projects,
        active: () => projects[0],
      })).toBe(true);
      await expect(fs.readFile(path.join(projectPath, 'AGENTS.md'), 'utf8'))
        .resolves.not.toContain(PANE_AGENT_CONTEXT_START);
    } finally {
      await fs.rm(offlinePath, { recursive: true, force: true });
    }
  });

  it('updates an existing agents.md variant while preserving user content', async () => {
    const projectPath = await createTempProject();
    const agentsPath = path.join(projectPath, 'agents.md');
    await fs.writeFile(agentsPath, '# Repo Rules\n\nKeep this line.\n', 'utf8');

    const first = await ensureProjectAgentContext({ path: projectPath }, enabledConfig());
    const second = await ensureProjectAgentContext({ path: projectPath }, enabledConfig());

    expect(first.changed).toBe(true);
    expect(first.filePath).toBe(agentsPath);
    expect(second.changed).toBe(false);
    const content = await fs.readFile(agentsPath, 'utf8');
    expect(content).toContain('# Repo Rules');
    expect(content).toContain('Keep this line.');
    expect(content.match(/pane-agent-context:start/g)).toHaveLength(1);
  });

  it('replaces only the managed block on subsequent writes', async () => {
    const projectPath = await createTempProject();
    const agentsPath = path.join(projectPath, 'AGENTS.md');
    await fs.writeFile(agentsPath, [
      '# User Top',
      '',
      PANE_AGENT_CONTEXT_START,
      'old managed content',
      PANE_AGENT_CONTEXT_END,
      '',
      '# User Bottom',
      ''
    ].join('\n'), 'utf8');

    await ensureProjectAgentContext({ path: projectPath }, enabledConfig());

    const content = await fs.readFile(agentsPath, 'utf8');
    expect(content).toContain('# User Top');
    expect(content).toContain('# User Bottom');
    expect(content).not.toContain('old managed content');
    expect(content).toContain('runpane doctor --json');
    expect(content.match(/pane-agent-context:start/g)).toHaveLength(1);
  });

  it('neither writes nor removes a block while the setting is off', async () => {
    const projectPath = await createTempProject();
    const agentsPath = path.join(projectPath, 'AGENTS.md');
    const agentsWithBlock = [
      '# User Top',
      '',
      PANE_AGENT_CONTEXT_START,
      'old managed content',
      PANE_AGENT_CONTEXT_END,
      '',
      '# User Bottom',
      ''
    ].join('\n');
    await fs.writeFile(agentsPath, agentsWithBlock, 'utf8');
    const emptyProjectPath = await createTempProject();

    const existing = await ensureProjectAgentContext({ path: projectPath }, disabledConfig());
    const fresh = await ensureProjectAgentContext({ path: emptyProjectPath }, disabledConfig());

    expect(existing).toMatchObject({ changed: false, skipped: 'disabled' });
    expect(fresh).toMatchObject({ changed: false, skipped: 'disabled' });
    await expect(fs.readFile(agentsPath, 'utf8')).resolves.toBe(agentsWithBlock);
    await expect(fs.readdir(emptyProjectPath)).resolves.toEqual([]);
  });

  it('does not follow symlinked AGENTS.md files', async () => {
    const projectPath = await createTempProject();
    const outsidePath = await createTempProject();
    const targetPath = path.join(outsidePath, 'outside-agents-target');
    const agentsPath = path.join(projectPath, 'AGENTS.md');
    await fs.writeFile(targetPath, 'outside file\n', 'utf8');

    try {
      await fs.symlink(targetPath, agentsPath);
    } catch {
      return;
    }

    const result = await ensureProjectAgentContext({ path: projectPath }, enabledConfig());

    expect(result).toMatchObject({ changed: false, skipped: 'unsafe-file' });
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('outside file\n');
  });
});
