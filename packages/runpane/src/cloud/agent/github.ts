import type { JsonObject, JsonValue } from '../../boundaryDecoder';
import type { ItemResult } from './brokerClient';
import { lastValue, parseAgentFlags, parseItemNumber, UnsupportedFlagError, type FlagSpec, type ParsedFlags } from './flags';
import { currentBranch, repoRoot } from './localGit';
import { pushBranch, readBody, resolveDir, resolveRepo, sessionBroker, type AgentDeps } from './session';

/**
 * `runpane cloud agent github ...`: inside a cloud Session, publish work to GitHub through the
 * coordinator's broker. Branches land under `cloud/<host>/`, pull requests are drafts.
 */

export const AGENT_GITHUB_USAGE = `Usage (inside a runpane cloud Session):
  runpane cloud agent github status [--json]
  runpane cloud agent github push [--path <dir>] [--branch <branch>] [--repo <owner/name>] [--force] [--json]
      Publish a local branch (default: the current one) to cloud/<host>/<branch> on GitHub.
  runpane cloud agent github pr create --title <title> (--body <text>|--body-file <path|->) [--base <branch>] [--branch <branch>] [--no-push] [--repo <owner/name>] [--json]
      Push the branch, then open a DRAFT pull request from cloud/<host>/<branch>.
  runpane cloud agent github pr edit <number> [--title <title>] [--body <text>|--body-file <path|->] [--repo] [--json]
  runpane cloud agent github pr close <number> [--repo] [--json]
  runpane cloud agent github pr comment <number> (--body <text>|--body-file <path|->) [--repo] [--json]
  runpane cloud agent github issue create --title <title> (--body <text>|--body-file <path|->) [--label <name>]... [--repo] [--json]
  runpane cloud agent github issue comment <number> (--body <text>|--body-file <path|->) [--repo] [--json]
  runpane cloud agent github issue close <number> [--repo] [--json]
  runpane cloud agent github read <path> [--repo] [--json]
      Read-only GitHub REST for the repository, e.g. pulls/12, pulls/12/files, issues?state=open, commits/<sha>/status.
--repo defaults to the origin remote of --path (default: the current directory).`;

const COMMON = { repo: ['--repo', '-R'], path: ['--path'], json: ['--json'] } as const;

function spec(values: (readonly string[])[], booleans: (readonly string[])[] = []): FlagSpec {
  return { values: [COMMON.repo, COMMON.path, ...values], booleans: [COMMON.json, ...booleans] };
}

const BODY = [['--body', '-b'], ['--body-file', '-F']] as const;

export async function runAgentGitHub(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const [group, ...rest] = argv;
  if (group === undefined || group === 'help' || group === '--help' || group === '-h') {
    deps.stdout(AGENT_GITHUB_USAGE);
    return group === undefined ? 1 : 0;
  }
  try {
    switch (group) {
      case 'status': return await status(rest, deps);
      case 'push': return await push(rest, deps);
      case 'read': return await read(rest, deps);
      case 'pr': return await pr(rest, deps);
      case 'issue': return await issue(rest, deps);
      default: throw new Error(`Unknown command: runpane cloud agent github ${group}\n\n${AGENT_GITHUB_USAGE}`);
    }
  } catch (error) {
    if (error instanceof UnsupportedFlagError) throw new Error(`Unknown option: ${error.flag}\n\n${AGENT_GITHUB_USAGE}`);
    throw error;
  }
}

function emit(deps: AgentDeps, flags: ParsedFlags, json: JsonObject, text: string): number {
  deps.stdout(flags.booleans.has('--json') ? JSON.stringify({ ok: true, ...json }, null, 2) : text);
  return 0;
}

async function repoFor(deps: AgentDeps, flags: ParsedFlags): Promise<string> {
  return resolveRepo(deps, lastValue(flags, '--repo'), resolveDir(deps, lastValue(flags, '--path')));
}

async function requireBody(deps: AgentDeps, flags: ParsedFlags, what: string): Promise<string> {
  const body = await readBody(deps, lastValue(flags, '--body'), lastValue(flags, '--body-file'));
  if (body === undefined || body.trim() === '') throw new Error(`${what} needs --body <text> or --body-file <path|->.`);
  return body;
}

function one(flags: ParsedFlags, what: string): number {
  if (flags.positionals.length !== 1) throw new Error(`${what} takes one number.\n\n${AGENT_GITHUB_USAGE}`);
  return parseItemNumber(flags.positionals[0], what);
}

function itemJson(item: ItemResult): JsonObject {
  return { number: item.number, url: item.url, state: item.state };
}

async function status(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const flags = parseAgentFlags(argv, spec([]));
  const broker = sessionBroker(deps);
  const answer = await broker.status();
  const lines = [`runpane cloud GitHub broker at ${broker.baseUrl}: ${answer.mode === 'off' ? 'not configured (off)' : `${answer.mode === 'app' ? `GitHub App${answer.app ? ` ${answer.app}` : ''}` : 'fine-grained token'}`}.`];
  if (answer.caller) {
    lines.push(`  this Session: ${answer.caller.host ?? 'unknown host'}; repositories: ${answer.caller.repos.join(', ') || 'none'}; branches under ${answer.caller.branchPrefix ?? 'cloud/<host>/'}`);
  } else if (answer.repos.length > 0) {
    lines.push(`  credential reaches: ${answer.repos.join(', ')}`);
  }
  lines.push('  pull requests open as drafts; the default branch (main/master) is never written.');
  const json: JsonObject = { mode: answer.mode, app: answer.app, repos: answer.repos, coordinator: broker.baseUrl };
  if (answer.caller) json.caller = { host: answer.caller.host, repos: answer.caller.repos, branchPrefix: answer.caller.branchPrefix };
  return emit(deps, flags, json, lines.join('\n'));
}

async function push(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const flags = parseAgentFlags(argv, spec([['--branch']], [['--force', '-f']]));
  if (flags.positionals.length > 0) throw new Error(`runpane cloud agent github push takes no positional arguments.\n\n${AGENT_GITHUB_USAGE}`);
  const result = await pushBranch(deps, {
    dir: resolveDir(deps, lastValue(flags, '--path')),
    branch: lastValue(flags, '--branch'),
    repo: lastValue(flags, '--repo'),
    force: flags.booleans.has('--force'),
  });
  return emit(deps, flags, {
    repo: result.repo, branch: result.branch, ref: result.ref, sha: result.sha, outcome: result.outcome,
    compareUrl: result.compareUrl, commits: result.commits, base: result.base, bundleBytes: result.bundleBytes,
  }, [
    `Pushed ${result.branch} (${result.head.slice(0, 12)}, ${result.commits} commit${result.commits === 1 ? '' : 's'}) to ${result.repo} ${result.ref} (${result.outcome}).`,
    ...(result.compareUrl ? [`  compare: ${result.compareUrl}`] : []),
  ].join('\n'));
}

async function read(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const flags = parseAgentFlags(argv, spec([]));
  if (flags.positionals.length !== 1) throw new Error(`runpane cloud agent github read takes one path, e.g. pulls/12.\n\n${AGENT_GITHUB_USAGE}`);
  const data: JsonValue = await sessionBroker(deps).read(await repoFor(deps, flags), flags.positionals[0]);
  deps.stdout(JSON.stringify(flags.booleans.has('--json') ? { ok: true, data } : data, null, 2));
  return 0;
}

async function pr(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const [action, ...rest] = argv;
  const broker = () => sessionBroker(deps);
  switch (action) {
    case 'create': {
      const flags = parseAgentFlags(rest, spec([['--title', '-t'], ...BODY, ['--base', '-B'], ['--branch', '--head', '-H']], [['--no-push'], ['--draft', '-d']]));
      const title = lastValue(flags, '--title');
      if (!title?.trim()) throw new Error('pr create needs --title.');
      const body = await requireBody(deps, flags, 'pr create');
      const dir = resolveDir(deps, lastValue(flags, '--path'));
      const repo = await repoFor(deps, flags);
      const branch = lastValue(flags, '--branch') ?? await currentBranch(deps.git, await repoRoot(deps.git, dir));
      let pushed: JsonObject | null = null;
      if (!flags.booleans.has('--no-push')) {
        const result = await pushBranch(deps, { dir, branch, repo, force: false });
        pushed = { ref: result.ref, sha: result.sha, outcome: result.outcome };
        deps.stderr(`Pushed ${branch} to ${result.ref} (${result.outcome}).`);
      }
      const item = await broker().createPull({ repo, branch, base: lastValue(flags, '--base'), title, body });
      return emit(deps, flags, { repo, branch, pushed, pull: itemJson(item) }, `Opened draft pull request #${item.number}: ${item.url}`);
    }
    case 'edit': {
      const flags = parseAgentFlags(rest, spec([['--title', '-t'], ...BODY]));
      const number = one(flags, 'pr edit');
      const title = lastValue(flags, '--title');
      const body = await readBody(deps, lastValue(flags, '--body'), lastValue(flags, '--body-file'));
      if (title === undefined && body === undefined) throw new Error('pr edit needs --title and/or --body/--body-file.');
      const item = await broker().editPull(number, { repo: await repoFor(deps, flags), title, body });
      return emit(deps, flags, { pull: itemJson(item) }, `Updated pull request #${item.number}: ${item.url}`);
    }
    case 'close': {
      const flags = parseAgentFlags(rest, spec([]));
      const item = await broker().editPull(one(flags, 'pr close'), { repo: await repoFor(deps, flags), state: 'closed' });
      return emit(deps, flags, { pull: itemJson(item) }, `Closed pull request #${item.number}: ${item.url}`);
    }
    case 'comment': {
      const flags = parseAgentFlags(rest, spec([...BODY]));
      const number = one(flags, 'pr comment');
      const result = await broker().comment({ repo: await repoFor(deps, flags), number, body: await requireBody(deps, flags, 'pr comment') });
      return emit(deps, flags, { number, url: result.url }, `Commented on #${number}${result.url ? `: ${result.url}` : ''}`);
    }
    default:
      throw new Error(`Unknown command: runpane cloud agent github pr ${action ?? ''}\n\n${AGENT_GITHUB_USAGE}`);
  }
}

async function issue(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const [action, ...rest] = argv;
  const broker = () => sessionBroker(deps);
  switch (action) {
    case 'create': {
      const flags = parseAgentFlags(rest, spec([['--title', '-t'], ...BODY, ['--label', '-l']]));
      const title = lastValue(flags, '--title');
      if (!title?.trim()) throw new Error('issue create needs --title.');
      const labels = (flags.values.get('--label') ?? []).flatMap((value) => value.split(',')).map((label) => label.trim()).filter(Boolean);
      const item = await broker().createIssue({ repo: await repoFor(deps, flags), title, body: await requireBody(deps, flags, 'issue create'), labels });
      return emit(deps, flags, { issue: itemJson(item) }, `Opened issue #${item.number}: ${item.url}`);
    }
    case 'comment': {
      const flags = parseAgentFlags(rest, spec([...BODY]));
      const number = one(flags, 'issue comment');
      const result = await broker().comment({ repo: await repoFor(deps, flags), number, body: await requireBody(deps, flags, 'issue comment') });
      return emit(deps, flags, { number, url: result.url }, `Commented on #${number}${result.url ? `: ${result.url}` : ''}`);
    }
    case 'close': {
      const flags = parseAgentFlags(rest, spec([]));
      const item = await broker().editIssue(one(flags, 'issue close'), { repo: await repoFor(deps, flags), state: 'closed' });
      return emit(deps, flags, { issue: itemJson(item) }, `Closed issue #${item.number}: ${item.url}`);
    }
    default:
      throw new Error(`Unknown command: runpane cloud agent github issue ${action ?? ''}\n\n${AGENT_GITHUB_USAGE}`);
  }
}
