import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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

  it('creates AGENTS.md with a managed Pane block by default', async () => {
    const projectPath = await createTempProject();

    const result = await ensureProjectAgentContext({ path: projectPath }, enabledConfig());

    expect(result.changed).toBe(true);
    expect(result.filePath).toBe(path.join(projectPath, 'AGENTS.md'));
    const content = await fs.readFile(path.join(projectPath, 'AGENTS.md'), 'utf8');
    expect(content).toContain(PANE_AGENT_CONTEXT_START);
    expect(content).toContain('runpane doctor --json');
    expect(content).toContain('runpane agent-context');
    expect(content).toContain('Default to context-safe validation');
    expect(content).toContain('runpane watch --follow');
    expect(content).toContain('Prefer `runpane panels submit` for normal text plus Enter');
    expect(content).toContain('Set-Location $env:TEMP');
    expect(content).toContain('broken Windows shim');
    expect(content).toContain(PANE_AGENT_CONTEXT_END);
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
    expect(content.match(/pane-agent-context:start/g)).toHaveLength(1);
  });

  it('removes the Pane-owned block when managed AGENTS is disabled', async () => {
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

    const result = await ensureProjectAgentContext({ path: projectPath }, disabledConfig());

    expect(result).toMatchObject({ changed: true, removed: true, filePath: agentsPath });
    const content = await fs.readFile(agentsPath, 'utf8');
    expect(content).toContain('# User Top');
    expect(content).toContain('# User Bottom');
    expect(content).not.toContain(PANE_AGENT_CONTEXT_START);
  });

  it('keeps an otherwise empty AGENTS.md file when disabling', async () => {
    const projectPath = await createTempProject();
    const agentsPath = path.join(projectPath, 'AGENTS.md');

    await ensureProjectAgentContext({ path: projectPath }, enabledConfig());
    await ensureProjectAgentContext({ path: projectPath }, disabledConfig());

    await expect(fs.access(agentsPath)).resolves.toBeUndefined();
    await expect(fs.readFile(agentsPath, 'utf8')).resolves.toBe('');
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
