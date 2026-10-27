import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../types/config';
import type { DetectedProjectConfig } from '../../../shared/types/projectConfig';
import { SETUP_SECTION_IDS, type SetupFile } from '../../../shared/types/setupTransfer';
import { PaneError } from '../../../shared/paneError';
import { exportSetup, previewSetupImport, readSetupFile, type SetupProject, type SetupSources } from './setupTransfer';

const NOW = new Date('2026-10-26T22:40:00Z');

interface Fixture {
  config?: AppConfig;
  projects?: Array<SetupProject & { origin?: string; detected?: DetectedProjectConfig }>;
  preferences?: SetupSources['preferences'];
  home?: string;
  platform?: string;
}

function sources({ config = {}, projects = [], preferences = {}, home = '/Users/ana', platform = 'darwin' }: Fixture): SetupSources {
  return {
    config,
    preferences,
    projects,
    readOrigin: async project => projects.find(candidate => candidate.id === project.id)?.origin ?? null,
    detectConfig: async project => projects.find(candidate => candidate.id === project.id)?.detected ?? null,
    home,
    platform,
    appVersion: '2.4.202',
  };
}

function setupFile(sections: SetupFile['sections'], platform = 'darwin'): SetupFile {
  return { kind: 'pane-setup', version: 1, exportedAt: NOW.toISOString(), appVersion: '2.4.202', platform, sections };
}

function rejection(text: string): string {
  try {
    readSetupFile(text, 'notes.json');
  } catch (error) {
    if (error instanceof PaneError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('exportSetup', () => {
  it('writes only allowlisted settings, with the home folder as ~', async () => {
    const config: AppConfig = {
      anthropicApiKey: 'sk-ant-fake-0001',
      openaiApiKey: 'sk-fake-openai-0002',
      deepgramApiKey: 'dg-fake-0003',
      claudeExecutablePath: '/Users/ana/.local/bin/claude',
      additionalPaths: ['/Users/ana/bin'],
      preferredShell: 'pwsh',
      autoStartOnBoot: true,
      devMode: true,
      analytics: { enabled: true, distinctId: 'fake-distinct-id' },
      agentContext: { managedAgentsMd: true, registerMcp: true, homeSkill: false, mcpToolsets: ['core', 'git'], defaultsVersion: 3 },
      defaultOrchestratorAgent: 'codex',
      defaultSessionCommand: 'claude --dangerously-skip-permissions',
      defaultPermissionMode: 'ignore',
      customCommands: [{ name: 'serve', command: '/Users/ana/bin/serve --port 3000' }],
      terminalShortcuts: [{ id: 'gs', label: 'Status', key: 'g', text: 'git status', enabled: true }],
      worktreeFileSync: [
        { id: 'env', path: '.env*', enabled: true, recursive: true },
        { id: 'abs', path: '/Users/ana/secrets', enabled: true, recursive: false },
      ],
      appearanceMode: 'fixed',
      theme: 'dark',
      uiScale: 1.1,
      keyboardShortcutsEnabled: false,
      sessionCreationPreferences: { sessionCount: 2, baseBranch: 'ana/local-branch' },
    };
    const { file } = await exportSetup(sources({
      config,
      preferences: { auto_rename_sessions_to_pr: 'false' },
      projects: [
        { id: 1, name: 'acme-web', run_script: 'pnpm dev', origin: 'git@github.com:Acme/acme-web.git' },
        { id: 2, name: 'notes', run_script: '', build_script: null },
      ],
    }), SETUP_SECTION_IDS, NOW);

    expect(file).toEqual({
      kind: 'pane-setup',
      version: 1,
      exportedAt: '2026-10-26T22:40:00.000Z',
      appVersion: '2.4.202',
      platform: 'darwin',
      sections: {
        agentPresets: { defaultOrchestratorAgent: 'codex', defaultSessionCommand: 'claude --dangerously-skip-permissions', defaultPermissionMode: 'ignore' },
        customCommands: [{ name: 'serve', command: '~/bin/serve --port 3000' }],
        runScripts: [{ name: 'acme-web', remote: 'github.com/acme/acme-web', run_script: 'pnpm dev' }],
        skills: { homeSkill: false, registerMcp: true, mcpToolsets: ['core', 'git'] },
        terminalShortcuts: [{ id: 'gs', label: 'Status', key: 'g', text: 'git status', enabled: true }],
        worktreeFileSync: [{ id: 'env', path: '.env*', enabled: true, recursive: true }],
        appearance: { appearanceMode: 'fixed', theme: 'dark', uiScale: 1.1 },
        preferences: { keyboardShortcutsEnabled: false, sessionCreationPreferences: { sessionCount: 2 }, auto_rename_sessions_to_pr: 'false' },
      },
    });
    expect(JSON.stringify(file)).not.toMatch(/fake|\/Users\/ana|ana\/local-branch/);
  });

  it('leaves out commands and scripts that look like they hold a secret, and names them', async () => {
    const { file, rows, leftOut } = await exportSetup(sources({
      config: {
        customCommands: [
          { name: 'deploy-prod', command: 'API_TOKEN=abc123 ./deploy' },
          { name: 'db', command: 'psql --password hunter2' },
          { name: 'auth', command: 'gh auth login --with-token-file ./t' },
          { name: 'dev', command: 'pnpm dev --token-file ./x' },
          { name: 'env-ref', command: 'API_TOKEN=$API_TOKEN ./deploy' },
          { name: 'curl', command: 'curl -H "Authorization: Bearer abc" https://api.example.com' },
          { name: 'gh', command: 'GH=ghp_abcdefghijklmnop gh pr list' },
        ],
      },
      projects: [{ id: 1, name: 'billing-api', build_script: 'pnpm i', run_script: 'psql postgres://user:pw@host/db', origin: 'https://github.com/acme/billing-api' }],
    }), ['customCommands', 'runScripts'], NOW);

    expect(file.sections.customCommands?.map(command => command.name)).toEqual(['auth', 'dev', 'env-ref']);
    expect(file.sections.runScripts).toEqual([{ name: 'billing-api', remote: 'github.com/acme/billing-api', build_script: 'pnpm i' }]);
    expect(leftOut).toEqual([
      { section: 'customCommands', name: 'deploy-prod' },
      { section: 'customCommands', name: 'db' },
      { section: 'customCommands', name: 'curl' },
      { section: 'customCommands', name: 'gh' },
      { section: 'runScripts', name: 'billing-api Run Commands' },
    ]);
    expect(rows.map(row => [row.id, row.count, row.leftOut.length])).toEqual([['customCommands', 3, 4], ['runScripts', 1, 1]]);
  });

  it('rewrites a Windows home folder in either slash style and any case', async () => {
    const { file } = await exportSetup(sources({
      home: 'C:\\Users\\Ana',
      platform: 'win32',
      config: {
        customCommands: [
          { name: 'a', command: 'c:/users/ana/bin/serve.cmd' },
          { name: 'b', command: 'C:\\Users\\Ana\\tools\\x.exe --flag' },
          { name: 'c', command: 'C:\\Users\\Anabel\\x.exe' },
        ],
      },
    }), ['customCommands'], NOW);

    expect(file.sections.customCommands?.map(command => command.command)).toEqual(['~/bin/serve.cmd', '~\\tools\\x.exe --flag', 'C:\\Users\\Anabel\\x.exe']);
  });

  it('summarizes each row for the card', async () => {
    const { rows } = await exportSetup(sources({
      config: { defaultOrchestratorAgent: 'claude', defaultSessionCommand: 'codex --yolo', agentContext: { registerMcp: false }, appearanceMode: 'system', systemDarkTheme: 'dusk' },
    }), ['agentPresets', 'skills', 'appearance'], NOW);

    expect(rows).toEqual([
      { id: 'agentPresets', count: 2, leftOut: [], agents: ['Claude Code', 'Codex'] },
      { id: 'skills', count: 2, leftOut: [], skills: { homeSkill: true, registerMcp: false } },
      { id: 'appearance', count: 2, leftOut: [], appearance: { mode: 'system', theme: 'light-rounded', light: 'light-rounded', dark: 'dusk' } },
    ]);
  });
});

describe('readSetupFile', () => {
  it('rejects anything that is not a v1 Pane setup file', () => {
    const valid = setupFile({});
    expect(rejection('not json')).toBe('ERR_SETUP_FILE_NOT_JSON');
    expect(rejection(JSON.stringify({ ...valid, kind: 'pane-notes' }))).toBe('ERR_SETUP_FILE_WRONG_KIND');
    expect(rejection(JSON.stringify({ ...valid, version: 2 }))).toBe('ERR_SETUP_FILE_NEWER_VERSION');
    expect(rejection(' '.repeat(1024 * 1024 + 1))).toBe('ERR_SETUP_FILE_TOO_LARGE');
    expect(rejection(JSON.stringify({ ...valid, sections: { customCommands: { name: 'x' } } }))).toBe('ERR_SETUP_FILE_INVALID_SECTION');
    expect(rejection(JSON.stringify(valid))).toBe('accepted');
  });

  it('says what happened, that nothing changed, and what to do next', () => {
    expect(() => readSetupFile(JSON.stringify({ ...setupFile({}), sections: { customCommands: [{ name: 'x', command: 1 }] } }), 'pane-setup.json')).toThrow(
      "Couldn't import pane-setup.json: its Custom commands section is malformed (at [0].command: expected string). Nothing changed.",
    );
    expect(() => readSetupFile(JSON.stringify({ kind: 'notes' }), 'notes.json')).toThrow(
      expect.objectContaining({
        message: "Couldn't import notes.json: it isn't a Pane setup file. Nothing changed.",
        next: 'Choose a file exported from Settings › Import & Export.',
      }),
    );
  });

  it('ignores sections and keys it does not know, including never-exported settings', () => {
    const file = readSetupFile(JSON.stringify({
      ...setupFile({}),
      sections: {
        agentPresets: { defaultModel: 'opus', anthropicApiKey: 'sk-ant-fake', claudeExecutablePath: '/x/claude' },
        analytics: { enabled: false },
        loops: [],
      },
    }), 'hand-edited.json');

    expect(file.sections).toEqual({ agentPresets: { defaultModel: 'opus' } });
  });
});

describe('previewSetupImport', () => {
  it('adds new commands, replaces same-name ones, and keeps local-only ones', async () => {
    const preview = await previewSetupImport(setupFile({
      customCommands: [
        { name: 'lint-fix', command: 'pnpm lint --fix' },
        { name: 'review', command: 'claude "/review --strict"' },
        { name: 'same', command: 'echo same' },
      ],
    }), 'pane-setup-2026-10-26.json', sources({
      config: { customCommands: [{ name: 'review', command: 'claude "/review"' }, { name: 'same', command: 'echo same' }, { name: 'mine', command: 'make' }] },
    }));

    const [section] = preview.sections;
    expect(section).toMatchObject({ id: 'customCommands', changes: 2, added: 1, replaced: 1 });
    expect(section?.items).toEqual([
      { kind: 'new', name: 'lint-fix', text: 'pnpm lint --fix' },
      { kind: 'replaces', name: 'review', text: 'claude "/review --strict"', was: 'claude "/review"' },
    ]);
    expect(section?.apply.config?.customCommands).toEqual([
      { name: 'review', command: 'claude "/review --strict"' },
      { name: 'same', command: 'echo same' },
      { name: 'mine', command: 'make' },
      { name: 'lint-fix', command: 'pnpm lint --fix' },
    ]);
  });

  it('turns off an incoming shortcut whose key a different local shortcut uses', async () => {
    const preview = await previewSetupImport(setupFile({
      terminalShortcuts: [
        { id: 'deploy', label: 'Deploy', key: 'g', text: 'pnpm deploy', enabled: true },
        { id: 'status', label: 'Status', key: 's', text: 'git status -sb', enabled: true },
      ],
    }), 'f.json', sources({
      config: { terminalShortcuts: [{ id: 'gs', label: 'Git status', key: 'g', text: 'git status', enabled: true }, { id: 'status', label: 'Status', key: 's', text: 'git status', enabled: true }] },
    }));

    const [section] = preview.sections;
    expect(section).toMatchObject({ changes: 2, added: 1, replaced: 1, keyInUse: 1 });
    expect(section?.apply.config?.terminalShortcuts).toEqual([
      { id: 'gs', label: 'Git status', key: 'g', text: 'git status', enabled: true },
      { id: 'status', label: 'Status', key: 's', text: 'git status -sb', enabled: true },
      { id: 'deploy', label: 'Deploy', key: 'g', text: 'pnpm deploy', enabled: false },
    ]);
  });

  it('merges worktree file sync by path and keeps the local id', async () => {
    const preview = await previewSetupImport(setupFile({
      worktreeFileSync: [
        { id: 'x1', path: '.env*', enabled: false, recursive: true },
        { id: 'env', path: '.tool-versions', enabled: true, recursive: false },
      ],
    }), 'f.json', sources({ config: { worktreeFileSync: [{ id: 'env', path: '.env*', enabled: true, recursive: true }] } }));

    expect(preview.sections[0]?.apply.config?.worktreeFileSync).toEqual([
      { id: 'env', path: '.env*', enabled: false, recursive: true },
      { id: 'env-2', path: '.tool-versions', enabled: true, recursive: false },
    ]);
  });

  it('replaces single values that differ and dims a section with no changes', async () => {
    const preview = await previewSetupImport(setupFile({
      agentPresets: { defaultOrchestratorAgent: 'codex', defaultModel: 'opus' },
      appearance: { appearanceMode: 'fixed', theme: 'dusk' },
      skills: { registerMcp: true, homeSkill: true },
      preferences: { keyboardShortcutsEnabled: true, sessionCreationPreferences: { sessionCount: 3 }, sidebar_attention_inbox: 'true' },
    }), 'f.json', sources({
      config: { defaultOrchestratorAgent: 'claude', defaultModel: 'opus', appearanceMode: 'fixed', theme: 'dark', agentContext: { registerMcp: false }, sessionCreationPreferences: { sessionCount: 1, baseBranch: 'main' } },
      preferences: { sidebar_attention_inbox: 'true' },
    }));

    const byId = Object.fromEntries(preview.sections.map(section => [section.id, section]));
    expect(byId.agentPresets?.apply).toEqual({ config: { defaultOrchestratorAgent: 'codex' } });
    expect(byId.appearance).toMatchObject({ changes: 1, theme: 'dusk', apply: { config: { theme: 'dusk' } } });
    expect(byId.skills).toMatchObject({ changes: 1, skills: ['mcp-on'], apply: { config: { agentContext: { registerMcp: true } } } });
    expect(byId.preferences?.apply).toEqual({
      config: { keyboardShortcutsEnabled: true, sessionCreationPreferences: { sessionCount: 3, baseBranch: 'main' } },
    });

    const unchanged = await previewSetupImport(setupFile({ agentPresets: { defaultModel: 'opus' } }), 'f.json', sources({ config: { defaultModel: 'opus' } }));
    expect(unchanged.sections).toEqual([{ id: 'agentPresets', changes: 0, added: 0, replaced: 0, keyInUse: 0, items: [], apply: {} }]);
  });

  it('matches repositories by host/owner/repo and skips what it cannot place', async () => {
    const file = setupFile({
      runScripts: [
        { name: 'acme-web', remote: 'github.com/acme/acme-web', build_script: 'pnpm i', run_script: '~/bin/serve' },
        { name: 'billing-api', remote: 'github.com/acme/billing-api', build_script: 'pnpm i && pnpm db:gen' },
        { name: 'marketing-site', remote: 'gitlab.com/acme/marketing-site', run_script: 'pnpm dev' },
        { name: 'scratch', remote: null, run_script: 'make' },
        { name: 'twin', remote: null, run_script: 'make twin' },
      ],
    }, 'darwin');
    const preview = await previewSetupImport(file, 'f.json', sources({
      home: 'C:\\Users\\Bo',
      platform: 'win32',
      projects: [
        { id: 1, name: 'web', origin: 'https://github.com/Acme/acme-web.git', detected: { setup: 'npm ci', source: 'pane.json' } },
        { id: 2, name: 'billing', build_script: 'pnpm i', origin: 'git@github.com:acme/billing-api.git' },
        { id: 3, name: 'marketing-site', origin: 'git@github.com:acme/marketing-site.git' },
        { id: 4, name: 'scratch' },
        { id: 5, name: 'twin' },
        { id: 6, name: 'twin' },
      ],
    }));

    const [section] = preview.sections;
    expect(preview.otherPlatform).toBe(true);
    expect(section?.repositories).toEqual({ matched: 3, total: 5 });
    expect(section?.items).toEqual([
      { kind: 'new', name: 'web', field: 'Run Commands', text: 'C:\\Users\\Bo/bin/serve' },
      { kind: 'replaces', name: 'billing', field: 'Build Script', text: 'pnpm i && pnpm db:gen', was: 'pnpm i' },
      { kind: 'new', name: 'scratch', field: 'Run Commands', text: 'make' },
      { kind: 'skipped', name: 'web', field: 'Build Script', reason: 'pane.json already provides it', cause: 'config-file', source: 'pane.json' },
      { kind: 'skipped', name: 'marketing-site', reason: 'not in Pane on this computer', cause: 'missing' },
      { kind: 'skipped', name: 'twin', reason: 'more than one repository in Pane is named twin', cause: 'ambiguous' },
    ]);
    expect(section?.apply.projects).toEqual([
      { id: 1, name: 'web', updates: { run_script: 'C:\\Users\\Bo/bin/serve' } },
      { id: 2, name: 'billing', updates: { build_script: 'pnpm i && pnpm db:gen' } },
      { id: 4, name: 'scratch', updates: { run_script: 'make' } },
    ]);
  });
});
