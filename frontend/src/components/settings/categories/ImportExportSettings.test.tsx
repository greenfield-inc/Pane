import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupCard, type SetupCardProps } from './ImportExportSettings';
import { SETTINGS_CATEGORIES } from '../catalog';
import { applySetupImport, setupErrorText, type SetupImportDeps } from '../setupTransfer';
import type { SetupExportSummary, SetupImportPreview, SetupSectionId } from '../../../../../shared/types/setupTransfer';

const summary: SetupExportSummary = {
  rows: [
    { id: 'agentPresets', count: 2, leftOut: [], agents: ['Claude Code', 'Codex'] },
    { id: 'customCommands', count: 2, leftOut: [{ section: 'customCommands', name: 'deploy-prod' }] },
    { id: 'runScripts', count: 4, leftOut: [] },
    { id: 'skills', count: 2, leftOut: [], skills: { homeSkill: true, registerMcp: true } },
    { id: 'terminalShortcuts', count: 4, leftOut: [] },
    { id: 'worktreeFileSync', count: 3, leftOut: [] },
    { id: 'appearance', count: 1, leftOut: [], appearance: { mode: 'fixed', theme: 'dark', light: 'light-rounded', dark: 'dark' } },
    { id: 'preferences', count: 14, leftOut: [] },
  ],
};

const file = {
  kind: 'pane-setup',
  version: 1,
  exportedAt: '2026-10-26T22:40:00Z',
  appVersion: '2.4.202',
  platform: 'darwin',
  sections: {},
} as const;

const preview: SetupImportPreview = {
  fileName: 'pane-setup-2026-10-26.json',
  appVersion: '2.4.202',
  platform: 'darwin',
  otherPlatform: false,
  file,
  sections: [
    { id: 'agentPresets', changes: 2, added: 0, replaced: 0, keyInUse: 0, items: [], apply: { config: { defaultOrchestratorAgent: 'codex' } } },
    {
      id: 'customCommands', changes: 3, added: 2, replaced: 1, keyInUse: 0,
      items: [
        { kind: 'new', name: 'lint-fix', text: 'pnpm lint --fix' },
        { kind: 'replaces', name: 'review', text: 'claude "/review --strict"', was: 'claude "/review"' },
      ],
      apply: { config: { customCommands: [{ name: 'lint-fix', command: 'pnpm lint --fix' }] } },
    },
    {
      id: 'runScripts', changes: 2, added: 1, replaced: 1, keyInUse: 0, repositories: { matched: 2, total: 3 },
      items: [
        { kind: 'new', name: 'acme-web', field: 'Run Commands', text: 'pnpm dev' },
        { kind: 'skipped', name: 'acme-web', field: 'Build Script', reason: 'pane.json already provides it', cause: 'config-file', source: 'pane.json' },
        { kind: 'skipped', name: 'marketing-site', reason: 'not in Pane on this computer', cause: 'missing' },
      ],
      apply: { projects: [{ id: 7, name: 'acme-web', updates: { run_script: 'pnpm dev' } }] },
    },
    { id: 'skills', changes: 1, added: 0, replaced: 0, keyInUse: 0, skills: ['mcp-on'], items: [], apply: { config: { agentContext: { registerMcp: true } } } },
    { id: 'terminalShortcuts', changes: 0, added: 0, replaced: 0, keyInUse: 0, items: [], apply: {} },
    { id: 'appearance', changes: 1, added: 0, replaced: 0, keyInUse: 0, theme: 'dark', items: [], apply: { config: { theme: 'dark' } } },
    {
      id: 'preferences', changes: 2, added: 0, replaced: 0, keyInUse: 0, items: [],
      apply: { config: { autoCheckUpdates: false }, preferences: { sidebar_pane_row_layout: 'two-row' } },
    },
  ],
};

const noop = () => undefined;
function render(overrides: Partial<SetupCardProps>) {
  return renderToStaticMarkup(
    <SetupCard
      platform="darwin"
      summary={summary}
      preview={null}
      selected={new Set<SetupSectionId>(['agentPresets', 'customCommands', 'runScripts', 'skills', 'terminalShortcuts', 'worktreeFileSync', 'appearance', 'preferences'])}
      expanded={new Set()}
      notice={null}
      busy={false}
      remoteHost={null}
      onToggle={noop}
      onExpand={noop}
      onExport={noop}
      onImport={noop}
      onCancel={noop}
      onConfirm={noop}
      onShowFile={noop}
      {...overrides}
    />,
  );
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
/** The opening tag of the first button whose markup contains `needle`. */
const button = (markup: string, needle: string) => {
  const chunk = markup.split('<button').find((candidate) => candidate.includes(needle)) ?? '';
  return chunk.slice(0, chunk.indexOf('>'));
};
const rowButton = (markup: string, label: string) => button(markup, `aria-label="${label}"`);

describe('Import & Export settings card', () => {
  it('is a category after Privacy that search finds by its aliases', () => {
    const ids = SETTINGS_CATEGORIES.map((category) => category.id);
    expect(ids.indexOf('import-export')).toBe(ids.indexOf('privacy') + 1);
    expect(SETTINGS_CATEGORIES.find((category) => category.id === 'import-export')?.aliases)
      .toEqual(expect.arrayContaining(['export', 'backup', 'new computer']));
  });

  it('A: lists every section checked with its summary, Import… before Export…', () => {
    const markup = render({});
    const visible = text(markup);
    expect(visible).toContain('Export your Pane setup');
    expect(visible).toContain('Agent presetsClaude Code · Codex');
    expect(visible).toContain('Run scripts4 repositories');
    expect(visible).toContain('Skills & MCPPane skill · MCP on');
    expect(visible).toContain('Worktree file sync3 paths');
    expect(visible).toContain('AppearanceDark (sharp)');
    expect(visible).toContain('Preferences14 settings');
    expect(visible.indexOf('Import…')).toBeLessThan(visible.indexOf('Export…'));
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(8);
  });

  it('shows both palettes when appearance follows the system', () => {
    const rows = summary.rows.map((row) => (row.id === 'appearance'
      ? { ...row, appearance: { mode: 'system' as const, theme: 'dark' as const, light: 'light-rounded' as const, dark: 'dark' as const } }
      : row));
    expect(text(render({ summary: { rows } }))).toContain('AppearanceLight (rounded) / Dark (sharp)');
  });

  it('B: shows a left-out row, an amber count, and the saved line with Show in Finder', () => {
    const markup = render({
      selected: new Set<SetupSectionId>(['agentPresets', 'customCommands']),
      notice: { kind: 'saved', result: { fileName: 'pane-setup-2026-10-26.json', filePath: '/Users/me/pane-setup-2026-10-26.json', leftOut: [{ section: 'customCommands', name: 'deploy-prod' }] } },
    });
    expect(rowButton(markup, 'Terminal shortcuts')).toContain('aria-checked="false"');
    expect(markup).toMatch(/text-status-warning[^>]*> · 1 left out</);
    expect(text(markup)).toContain('Saved pane-setup-2026-10-26.json. Left out deploy-prod because it looks like it contains a token. Show in Finder');
  });

  it('B: names several left-out items and says Show in folder off macOS', () => {
    const markup = render({
      platform: 'win32',
      notice: { kind: 'saved', result: { fileName: 'a.json', filePath: 'C:\\a.json', leftOut: [{ section: 'customCommands', name: 'deploy-prod' }, { section: 'customCommands', name: 'db' }] } },
    });
    expect(text(markup)).toContain('Left out deploy-prod and db because they look like they contain a token. Show in folder');
  });

  it('disables Export… when every row is left out', () => {
    const markup = render({ selected: new Set() });
    expect(button(markup, 'Export…')).toContain('disabled=""');
    expect(button(markup, 'Import…')).not.toContain('disabled=""');
  });

  it('C: previews per-section changes, dims a section with none, and counts what will import', () => {
    const markup = render({ preview, selected: new Set<SetupSectionId>(['agentPresets', 'customCommands', 'runScripts', 'skills', 'appearance']), expanded: new Set<SetupSectionId>(['customCommands', 'runScripts']) });
    const visible = text(markup);
    expect(visible).toContain('Import pane-setup-2026-10-26.json');
    expect(visible).toContain('From Pane 2.4.202 on macOS. Nothing is removed, and nothing changes until you import.');
    expect(visible).toContain('Agent presets2 changes');
    expect(visible).toContain('Custom commands2 new · 1 replaces');
    expect(visible).toContain('Run scripts2 of 3 repositories here');
    expect(visible).toContain('Skills & MCPTurns on MCP');
    expect(visible).toContain('AppearanceDark (sharp)');
    expect(visible).toContain('New lint-fixpnpm lint --fix');
    expect(visible).toContain('was claude "/review"');
    expect(visible).toContain('New acme-web · Run Commandspnpm dev');
    expect(visible).toContain('marketing-site · not in Pane on this computer, skipped');
    const shortcuts = rowButton(markup, 'Terminal shortcuts');
    expect(shortcuts).toContain('disabled=""');
    expect(shortcuts).toContain('aria-checked="false"');
    expect(visible).toContain('Terminal shortcutsNo changes');
    expect(visible).toContain('Import 5 sections');
    expect(visible).not.toContain('Export…');
  });

  it('C: labels scripts written on another OS', () => {
    expect(text(render({ preview: { ...preview, otherPlatform: true } }))).toContain('2 of 3 repositories here · written on macOS');
  });

  it('E: shows a wrong file as an alert under the rows', () => {
    const markup = render({
      notice: { kind: 'error', message: setupErrorText("Couldn't import notes.json: it isn't a Pane setup file. Nothing changed. Next: Choose a file exported from Settings › Import & Export.") },
    });
    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain("Couldn't import notes.json: it isn't a Pane setup file. Nothing changed. Choose a file exported from Settings › Import & Export.");
  });

  it('F: names the remote host and disables the card', () => {
    const markup = render({ remoteHost: 'studio-mac', summary: null });
    expect(text(markup)).toContain("You're connected to studio-mac. Choose This computer in the sidebar's host switcher to export or import this computer's setup.");
    expect(rowButton(markup, 'Agent presets')).toContain('disabled=""');
    expect(button(markup, 'Import…')).toContain('disabled=""');
    expect(button(markup, 'Export…')).toContain('disabled=""');
  });
});

describe('applySetupImport', () => {
  const chosen = new Set<SetupSectionId>(['agentPresets', 'customCommands', 'runScripts', 'skills', 'appearance', 'preferences']);

  function deps(overrides: Partial<SetupImportDeps> = {}) {
    const calls: string[] = [];
    const value: SetupImportDeps = {
      preview: vi.fn(async () => ({ success: true, data: preview })),
      updateConfig: vi.fn(async (patch) => { calls.push(`config ${Object.keys(patch).join(',')}`); return {}; }),
      savePreference: vi.fn(async (key, raw) => { calls.push(`preference ${key}=${raw}`); return true; }),
      updateProject: vi.fn(async (id, updates) => { calls.push(`project ${id} ${JSON.stringify(updates)}`); return { success: true }; }),
      capture: vi.fn(),
      ...overrides,
    };
    return { calls, value };
  }

  it('recomputes, then saves config once, then preferences, then projects, and records counts only', async () => {
    const { calls, value } = deps();
    const outcome = await applySetupImport(preview, chosen, value);

    expect(value.preview).toHaveBeenCalledWith(file, 'pane-setup-2026-10-26.json');
    expect(calls).toEqual([
      'config defaultOrchestratorAgent,customCommands,agentContext,theme,autoCheckUpdates',
      'preference sidebar_pane_row_layout=two-row',
      'project 7 {"run_script":"pnpm dev"}',
    ]);
    expect(value.capture).toHaveBeenCalledWith('setup_imported', {
      sections: ['agentPresets', 'customCommands', 'runScripts', 'skills', 'appearance', 'preferences'],
      section_count: 6,
      changes: { agentPresets: 2, customCommands: 3, runScripts: 2, skills: 1, appearance: 1, preferences: 2 },
    });
    expect(outcome).toEqual({
      kind: 'success',
      message: "Imported 6 sections. Skipped acme-web's Build Script, which its pane.json provides, and marketing-site, which isn't in Pane on this computer.",
    });
  });

  it('leaves out unchecked sections', async () => {
    const { calls, value } = deps();
    await applySetupImport(preview, new Set<SetupSectionId>(['appearance']), value);
    expect(calls).toEqual(['config theme']);
  });

  it('stops at the first failure, names what failed, and records no event', async () => {
    const { calls, value } = deps({
      updateProject: vi.fn(async () => ({ success: false, error: "acme-web's folder is missing. Next: Reopen the project." })),
    });
    const outcome = await applySetupImport(preview, chosen, value);

    expect(calls).toEqual([
      'config defaultOrchestratorAgent,customCommands,agentContext,theme,autoCheckUpdates',
      'preference sidebar_pane_row_layout=two-row',
    ]);
    expect(outcome).toEqual({
      kind: 'failure',
      message: "Imported 5 of 6 sections. Run scripts failed: acme-web's folder is missing. Nothing else changed. Import the file again to retry.",
    });
    expect(value.capture).not.toHaveBeenCalled();
  });

  it('saves no preferences or projects when the config save fails', async () => {
    const { calls, value } = deps({ updateConfig: vi.fn(async () => { throw new Error('theme is not a known palette'); }) });
    const outcome = await applySetupImport(preview, new Set<SetupSectionId>(['appearance', 'runScripts']), value);

    expect(calls).toEqual([]);
    expect(outcome).toEqual({
      kind: 'failure',
      message: 'Imported 0 of 2 sections. Appearance failed: theme is not a known palette. Nothing else changed. Import the file again to retry.',
    });
  });
});
