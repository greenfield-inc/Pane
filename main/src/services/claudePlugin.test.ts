import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { buildPaneHomeSkill, PANE_MANAGED_SKILL_MARKER } from './paneHomeSkill';

const repoRoot = path.join(__dirname, '..', '..', '..');
const pluginDir = path.join(repoRoot, 'claude-plugin');

// Pane's Claude plugin carries the skills and icon the app installs. `pnpm sync:claude-plugin`
// rewrites the plugin's copies; these fail while one is stale.
describe("Pane's Claude plugin folder", () => {
  it('carries the pane skill the app installs, without its managed-copy marker', async () => {
    await expect(buildPaneHomeSkill().replace(`${PANE_MANAGED_SKILL_MARKER}\n`, '')).toMatchFileSnapshot(path.join(pluginDir, 'skills', 'pane', 'SKILL.md'));
  });

  it('carries the pane-manage-and-message-agents skill the app installs', async () => {
    const source = readFileSync(path.join(__dirname, 'userSkills', 'pane-manage-and-message-agents', 'SKILL.md'), 'utf8');
    await expect(source).toMatchFileSnapshot(path.join(pluginDir, 'skills', 'pane-manage-and-message-agents', 'SKILL.md'));
  });

  it("carries the app's icon", () => {
    const same = readFileSync(path.join(repoRoot, 'main', 'assets', 'icon.png')).equals(readFileSync(path.join(pluginDir, 'assets', 'icon.png')));
    expect(same, 'Copy main/assets/icon.png to claude-plugin/assets/icon.png').toBe(true);
  });

  it('starts an exact runpane release with the plugin toolset, as the directory requires', () => {
    const manifest = decodeBoundary(JSON.parse(readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')), boundary.object({
      mcpServers: boundary.object({ pane: boundary.object({ command: boundary.string, args: boundary.array(boundary.string) }) }),
    }));
    const [yes, pinned, ...rest] = manifest.mcpServers.pane.args;
    expect(manifest.mcpServers.pane.command).toBe('npx');
    expect(yes).toBe('-y');
    expect(pinned).toMatch(/^runpane@\d+\.\d+\.\d+$/);
    expect(rest).toEqual(['mcp', '--toolsets', 'plugin']);
  });
});
