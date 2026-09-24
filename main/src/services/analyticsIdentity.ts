import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { getShellPath } from '../utils/shellPath';
import type { AnalyticsIdentity } from '../types/config';

function commandEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: getShellPath() };
}

const execFileAsync = promisify(execFile);

async function runCommand(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: os.homedir(),
      encoding: 'utf8',
      env: commandEnv(),
      timeout: 5000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface AnalyticsIdentityDependencies {
  runCommand(command: string, args: string[]): Promise<string | undefined>;
}

const defaultAnalyticsIdentityDependencies: AnalyticsIdentityDependencies = { runCommand };

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export async function resolveAnalyticsIdentity(
  existingDistinctId?: string,
  installId?: string,
  dependencies: AnalyticsIdentityDependencies = defaultAnalyticsIdentityDependencies,
): Promise<AnalyticsIdentity> {
  // Runs on every launch: async and in parallel so the main process keeps
  // answering the renderer while gh waits on the network.
  const [githubUsername, githubEmail, gitEmail, gitUserName] = await Promise.all([
    dependencies.runCommand('gh', ['api', 'user', '--jq', '.login']),
    dependencies.runCommand('gh', ['api', 'user', '--jq', '.email // empty']),
    dependencies.runCommand('git', ['config', '--global', 'user.email']),
    dependencies.runCommand('git', ['config', '--global', 'user.name']),
  ]);
  const email = githubEmail || gitEmail;
  const gitEmailHash = email ? sha256(email) : undefined;

  let distinctId = existingDistinctId || (installId ? `install:${installId}` : `anon-${Date.now().toString(36)}`);
  let identitySource: AnalyticsIdentity['identitySource'] =
    existingDistinctId && existingDistinctId !== `install:${installId}` ? 'posthog' : 'anonymous';

  if (email) {
    distinctId = `email:${email.trim().toLowerCase()}`;
    identitySource = 'email';
  } else if (githubUsername) {
    distinctId = `github:${githubUsername}`;
    identitySource = 'github';
  } else if (gitUserName) {
    distinctId = `git_name:${gitUserName.trim().toLowerCase()}`;
    identitySource = 'git_name';
  }

  return {
    distinctId,
    identitySource,
    installId,
    githubUsername,
    githubEmail,
    gitEmail,
    gitEmailHash,
    gitUserName,
  };
}

export function readWebAttribution(appDir: string): string | undefined {
  try {
    const token = fsSync.readFileSync(path.join(appDir, 'attribution_ref'), 'utf8').trim();
    if (!token) return undefined;

    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const separatorIndex = decoded.lastIndexOf('|');
    if (separatorIndex <= 0) return undefined;

    const distinctId = decoded.slice(0, separatorIndex);
    const issuedAt = decoded.slice(separatorIndex + 1);
    if (!/^\d+$/.test(issuedAt)) return undefined;

    return distinctId.length > 0 && distinctId.length <= 64 ? distinctId : undefined;
  } catch {
    return undefined;
  }
}
