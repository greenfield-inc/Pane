import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readSessionCoordinator } from '../../remote/hostDirectory';
import { parseRepoSpec } from '../github';
import { BrokerClient, BrokerError, MAX_BROKER_BODY_BYTES, type PushResult } from './brokerClient';
import { assertBrokerBranch, bundleBranch, currentBranch, defaultBranch, originRepo, repoRoot, runGit, type GitRunner } from './localGit';

/** What `runpane cloud agent ...` touches, so tests can point it at a mock broker and a temp repo. */
export interface AgentDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  git: GitRunner;
  /** Overrides the broker from the peers list (tests). */
  broker?: BrokerClient;
  /** The only host (`host[:port]`) git-credential-runpane answers for; github.com unless a test serves git locally. */
  gitHost?: string;
}

export function defaultAgentDeps(): AgentDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    stderr: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
    async readStdin() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return Buffer.concat(chunks).toString('utf8');
    },
    git: runGit,
  };
}

export function sessionBroker(deps: AgentDeps): BrokerClient {
  if (deps.broker) return deps.broker;
  const found = readSessionCoordinator(deps.env);
  if (!found) {
    throw new Error('No runpane cloud coordinator is configured here. This command runs inside a cloud Session whose peers list names one '
      + '(~/.config/runpane-cloud/peers.json, written by runpane cloud new / runpane cloud github connect --broker on your laptop).');
  }
  return new BrokerClient(found.coordinator);
}

/** The repository: `--repo`, else the origin remote of the checkout at `dir`. */
export async function resolveRepo(deps: AgentDeps, repoFlag: string | undefined, dir: string): Promise<string> {
  return repoFlag ? parseRepoSpec(repoFlag) : originRepo(deps.git, dir);
}

export function resolveDir(deps: AgentDeps, pathFlag: string | undefined): string {
  return pathFlag ? path.resolve(deps.cwd, pathFlag) : deps.cwd;
}

/** `--body <text>` or `--body-file <path|->`; undefined when neither was given. */
export async function readBody(deps: AgentDeps, body: string | undefined, bodyFile: string | undefined): Promise<string | undefined> {
  if (body !== undefined && bodyFile !== undefined) throw new Error('Give --body or --body-file, not both.');
  if (bodyFile === undefined) return body;
  return bodyFile === '-' ? deps.readStdin() : fs.readFile(path.resolve(deps.cwd, bodyFile), 'utf8');
}

interface PushOutcome extends PushResult {
  repo: string;
  branch: string;
  head: string;
  base: string | null;
  commits: number;
  bundleBytes: number;
}

/** Bundles `branch` (default: the current one) against origin's default branch and pushes it through the broker. */
export async function pushBranch(deps: AgentDeps, options: { dir: string; branch?: string; repo?: string; force: boolean }): Promise<PushOutcome> {
  const root = await repoRoot(deps.git, options.dir);
  const branch = assertBrokerBranch(options.branch ?? await currentBranch(deps.git, root));
  const repo = await resolveRepo(deps, options.repo, root);
  const base = await defaultBranch(deps.git, root);
  const bundle = await bundleBranch(deps.git, root, branch, base);
  // base64 grows by 4/3, plus a little JSON around it.
  if (Math.ceil(bundle.data.length / 3) * 4 + 4096 > MAX_BROKER_BODY_BYTES) {
    throw new Error(`The bundle for ${branch} is ${bundle.data.length} bytes; the coordinator takes about ${Math.floor(MAX_BROKER_BODY_BYTES * 3 / 4 / 1024 / 1024)} MiB. Push fewer or smaller commits.`);
  }
  let result;
  try {
    result = await sessionBroker(deps).push({ repo, branch, bundle: bundle.data, force: options.force });
  } catch (error) {
    if (error instanceof BrokerError && error.code === 'non-fast-forward') {
      throw new BrokerError(`${error.message} Rerun with --force to overwrite it (only ever your own cloud/<host>/${branch}).`, error.code, error.status);
    }
    throw error;
  }
  return { ...result, repo, branch, head: bundle.head, base: bundle.base, commits: bundle.commits, bundleBytes: bundle.data.length };
}
