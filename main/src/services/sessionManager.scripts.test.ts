import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DatabaseService } from '../database/database';
import { CommandRunner } from '../utils/commandRunner';
import { SessionManager } from './sessionManager';

class ProjectCommandRunner extends CommandRunner {
  override execAsync(command: string, cwd: string, options?: Parameters<CommandRunner['execAsync']>[2]) {
    return super.execAsync(command, cwd, {
      ...options,
      env: { ...options?.env, PANE_TEST_SCRIPT_RUNTIME: 'project' },
    });
  }
}

let directory: string;
let database: DatabaseService;
let manager: SessionManager;
let runner: CommandRunner;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pane-project-scripts-'));
  database = new DatabaseService(join(directory, 'sessions.db'));
  database.initialize();
  manager = new SessionManager(database);
  runner = new ProjectCommandRunner({ path: directory });
});

afterEach(async () => {
  await manager.cleanup();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

it('runs setup commands in the supplied project environment', async () => {
  const result = await manager.runBuildScript('session', [
    'node -p "process.env.PANE_TEST_SCRIPT_RUNTIME || \'host\'"',
  ], directory, runner);
  expect(result).toEqual({ success: true, output: 'project\n' });
});

it('keeps running archive commands after a failure and retains their output', async () => {
  const result = await manager.runArchiveScript('session', [
    'node -e "process.stderr.write(\'failed\\n\'); process.exit(1)"',
    ' ',
    'node -p "process.env.PANE_TEST_SCRIPT_RUNTIME"',
  ], directory, runner);
  expect(result).toEqual({ success: false, output: 'failed\nproject\n' });
});

it('gives setup and archive commands their project\'s variables and no other project\'s', async () => {
  const cura = database.createProject('cura', join(directory, 'cura'));
  const other = database.createProject('other', join(directory, 'other'));
  for (const [id, projectId] of [['cura-pane', cura.id], ['other-pane', other.id]] as const) {
    database.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: join(directory, id), project_id: projectId, tool_type: 'none' });
  }
  database.replaceProjectEnvVars(cura.id, [{ key: 'UIVERIFY_API_KEY', source: 'plain', value: 'from-project' }]);
  const print = ['node -p "process.env.UIVERIFY_API_KEY"'];

  await expect(manager.runBuildScript('cura-pane', print, directory, runner)).resolves.toEqual({ success: true, output: 'from-project\n' });
  await expect(manager.runArchiveScript('cura-pane', print, directory, runner)).resolves.toEqual({ success: true, output: 'from-project\n' });
  await expect(manager.runBuildScript('other-pane', print, directory, runner)).resolves.toEqual({ success: true, output: 'undefined\n' });
});
