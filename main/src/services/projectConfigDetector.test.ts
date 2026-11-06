import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProjectConfig } from './projectConfigDetector';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-config-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

const CONDUCTOR_JSON = JSON.stringify({ scripts: { setup: 'npm ci', run: 'npm start' } });

describe('detectProjectConfig with Conductor settings', () => {
  it('reads the scripts table of .conductor/settings.toml, taking the default run action', async () => {
    // The shape of Conductor's sample settings file (conductor.build/docs/reference/settings/example).
    write('.conductor/settings.toml', `"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

[scripts]
setup = """
pnpm install
cp "$CONDUCTOR_ROOT_PATH/.env" .env
"""
archive = "./script/workspace-archive.sh"
run_mode = "nonconcurrent"

[scripts.run.test]
command = "pnpm test --watch"

[scripts.run.dev]
command = "pnpm dev"
args = ["--port", "$CONDUCTOR_PORT"]
default = true
`);

    expect(await detectProjectConfig(root, 'macos')).toEqual({
      setup: 'pnpm install\ncp "$CONDUCTOR_ROOT_PATH/.env" .env\n',
      run: 'pnpm dev --port $CONDUCTOR_PORT',
      archive: './script/workspace-archive.sh',
      runScriptMode: 'nonconcurrent',
      source: '.conductor/settings.toml',
    });
  });

  it('reads the legacy one-command run', async () => {
    write('.conductor/settings.toml', '[scripts]\nrun = "pnpm dev"\n');

    expect(await detectProjectConfig(root, 'macos')).toMatchObject({ run: 'pnpm dev', source: '.conductor/settings.toml' });
  });

  it('prefers settings.toml to conductor.json', async () => {
    write('.conductor/settings.toml', '[scripts]\nsetup = "pnpm install"\n');
    write('conductor.json', CONDUCTOR_JSON);

    expect(await detectProjectConfig(root, 'macos')).toMatchObject({ setup: 'pnpm install', source: '.conductor/settings.toml' });
  });

  it('ignores conductor.json once settings.toml exists, as Conductor does, and falls through to the next file', async () => {
    write('.conductor/settings.toml', '[environment_variables]\nFOO = "bar"\n');
    write('conductor.json', CONDUCTOR_JSON);
    write('.gitpod.yml', 'tasks:\n  - init: make\n');

    expect(await detectProjectConfig(root, 'macos')).toMatchObject({ setup: 'make', source: '.gitpod.yml' });
  });

  it('still reads conductor.json in a repository without settings.toml', async () => {
    write('conductor.json', CONDUCTOR_JSON);

    expect(await detectProjectConfig(root, 'macos')).toMatchObject({ setup: 'npm ci', run: 'npm start', source: 'conductor.json' });
  });
});
