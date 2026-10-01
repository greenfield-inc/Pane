import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../../boundaryDecoder';
import { BrokerError } from './brokerClient';
import { sessionBroker, type AgentDeps } from './session';

/**
 * GitHub REST, as the broker's read passthrough returns it, mapped onto what `gh ... --json` prints: the
 * same field names, types and upper-case enums, because Pane itself parses gh's JSON (git status PR
 * badge, the Session PR monitor, archive's merged-PR check, the dashboard).
 */

const optionalText = boundary.optional(boundary.nullable(boundary.string));
const branchRefSchema = boundary.optional(boundary.nullable(boundary.object({ ref: optionalText, sha: optionalText })));

/** A GitHub REST pull request or issue (only what gh shows). */
const restItemSchema = boundary.object({
  number: boundary.number,
  title: optionalText,
  body: optionalText,
  state: optionalText,
  html_url: optionalText,
  user: boundary.optional(boundary.nullable(boundary.object({ login: optionalText }))),
  labels: boundary.optional(boundary.nullable(boundary.array(boundary.object({ name: optionalText })))),
  created_at: optionalText,
  updated_at: optionalText,
  closed_at: optionalText,
  merged_at: optionalText,
  merged: boundary.optional(boundary.nullable(boundary.boolean)),
  /** Only on a single pull request; null while GitHub is still computing it. */
  mergeable: boundary.optional(boundary.nullable(boundary.boolean)),
  node_id: optionalText,
  draft: boundary.optional(boundary.nullable(boundary.boolean)),
  head: branchRefSchema,
  base: branchRefSchema,
  pull_request: boundary.optional(boundary.nullable(boundary.json)),
});

export const commentsSchema = boundary.array(boundary.object({
  body: optionalText,
  user: boundary.optional(boundary.nullable(boundary.object({ login: optionalText }))),
}));

const checkRunsSchema = boundary.object({
  check_runs: boundary.array(boundary.object({
    name: optionalText,
    status: optionalText,
    conclusion: optionalText,
    started_at: optionalText,
    completed_at: optionalText,
    details_url: optionalText,
    html_url: optionalText,
  })),
});

const combinedStatusSchema = boundary.object({
  statuses: boundary.array(boundary.object({
    context: optionalText,
    state: optionalText,
    target_url: optionalText,
    created_at: optionalText,
  })),
});

const filesSchema = boundary.array(boundary.object({
  filename: boundary.string,
  previous_filename: optionalText,
  status: optionalText,
  patch: optionalText,
}));

export function decodeItem(value: JsonValue) {
  return decodeBoundary(value, restItemSchema);
}

export type RestItem = ReturnType<typeof decodeItem>;

export async function listItems(deps: AgentDeps, repo: string, path: string): Promise<RestItem[]> {
  return decodeBoundary(await sessionBroker(deps).read(repo, path), boundary.array(restItemSchema));
}

export function ghState(item: RestItem): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (item.state?.toLowerCase() !== 'closed') return 'OPEN';
  return item.merged_at || item.merged === true ? 'MERGED' : 'CLOSED';
}

export function labelNames(item: RestItem): string[] {
  return (item.labels ?? []).map((label) => label.name ?? '');
}

/** gh's `mergeable`: MERGEABLE, CONFLICTING, or UNKNOWN (not computed yet, or not in a list answer). */
function ghMergeable(item: RestItem): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (item.mergeable === true) return 'MERGEABLE';
  return item.mergeable === false ? 'CONFLICTING' : 'UNKNOWN';
}

/** A REST pull request or issue as gh's --json fields (statusCheckRollup is filled in by withRollup). */
export function ghFields(item: RestItem, kind: 'pr' | 'issue'): JsonObject {
  const fields: JsonObject = {
    number: item.number,
    title: item.title ?? '',
    body: item.body ?? '',
    state: ghState(item),
    url: item.html_url ?? '',
    author: { login: item.user?.login ?? '' },
    labels: labelNames(item).map((name) => ({ name })),
    createdAt: item.created_at ?? '',
    updatedAt: item.updated_at ?? '',
    closedAt: item.closed_at ?? null,
    id: item.node_id ?? '',
  };
  if (kind === 'pr') {
    fields.isDraft = item.draft === true;
    fields.headRefName = item.head?.ref ?? '';
    fields.headRefOid = item.head?.sha ?? '';
    fields.baseRefName = item.base?.ref ?? '';
    fields.mergedAt = item.merged_at ?? null;
    fields.mergeable = ghMergeable(item);
    fields.statusCheckRollup = [];
  }
  return fields;
}

/** gh's state column: a draft pull request shows as DRAFT. */
export function shownState(item: RestItem): string {
  const state = ghState(item);
  return item.draft === true && state === 'OPEN' ? 'DRAFT' : state;
}

function wantedNames(wanted: string): string[] {
  return wanted.split(',').map((name) => name.trim()).filter(Boolean);
}

export function pickFields(fields: JsonObject, wanted: string): JsonObject {
  const names = wantedNames(wanted);
  const unknown = names.filter((name) => !(name in fields));
  if (unknown.length > 0) throw new Error(`Unknown JSON field: ${unknown.join(', ')}\nAvailable fields:\n  ${Object.keys(fields).sort().join('\n  ')}`);
  return Object.fromEntries(names.map((name) => [name, fields[name]]));
}

/** The fields gh would print for a pull request, with statusCheckRollup read only when asked for. */
export async function pullJson(deps: AgentDeps, repo: string, item: RestItem, wanted: string): Promise<JsonObject> {
  const fields = ghFields(item, 'pr');
  if (wantedNames(wanted).includes('statusCheckRollup') && item.head?.sha) {
    fields.statusCheckRollup = await statusCheckRollup(deps, repo, item.head.sha);
  }
  return pickFields(fields, wanted);
}

// ---------------------------------------------------------------- checks

/**
 * gh's statusCheckRollup for a commit: its check runs (`__typename: CheckRun`, status and conclusion in
 * upper case) and commit statuses (`__typename: StatusContext`, state in upper case). A half the broker
 * can't read (the App lacks Checks or Statuses read) is left out, with a note on stderr.
 */
export async function statusCheckRollup(deps: AgentDeps, repo: string, sha: string): Promise<JsonObject[]> {
  const broker = sessionBroker(deps);
  const rollup: JsonObject[] = [];
  try {
    const runs = decodeBoundary(await broker.read(repo, `commits/${sha}/check-runs?per_page=100`), checkRunsSchema);
    for (const run of runs.check_runs) {
      rollup.push({
        __typename: 'CheckRun',
        name: run.name ?? '',
        status: (run.status ?? '').toUpperCase(),
        conclusion: (run.conclusion ?? '').toUpperCase(),
        startedAt: run.started_at ?? '',
        completedAt: run.completed_at ?? '',
        detailsUrl: run.details_url ?? run.html_url ?? '',
        workflowName: '',
      });
    }
  } catch (error) {
    if (!(error instanceof BrokerError)) throw error;
    deps.stderr(`note: check runs unavailable through the broker (${error.code}): ${error.message}`);
  }
  try {
    const combined = decodeBoundary(await broker.read(repo, `commits/${sha}/status?per_page=100`), combinedStatusSchema);
    for (const status of combined.statuses) {
      rollup.push({
        __typename: 'StatusContext',
        context: status.context ?? '',
        state: (status.state ?? '').toUpperCase(),
        targetUrl: status.target_url ?? '',
        startedAt: status.created_at ?? '',
      });
    }
  } catch (error) {
    if (!(error instanceof BrokerError)) throw error;
    deps.stderr(`note: commit statuses unavailable through the broker (${error.code}): ${error.message}`);
  }
  return rollup;
}

type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/** gh pr checks' bucket for one rollup entry. */
function bucket(entry: JsonObject): CheckBucket {
  const status = entry.__typename === 'StatusContext' ? entry.state : entry.status === 'COMPLETED' ? entry.conclusion : 'PENDING';
  if (status === 'SUCCESS' || status === 'NEUTRAL') return 'pass';
  if (status === 'SKIPPED' || status === 'STALE') return 'skipping';
  if (status === 'CANCELLED') return 'cancel';
  if (FAILING.has(String(status))) return 'fail';
  return 'pending';
}

/**
 * `gh pr checks` output: `name<TAB>bucket<TAB>elapsed<TAB>link` per check, and gh's exit codes
 * (1: a check failed, 8: some are pending). Returns the exit code.
 */
export function printChecks(deps: AgentDeps, rollup: JsonObject[], branch: string): number {
  if (rollup.length === 0) {
    deps.stderr(`no checks reported on the '${branch}' branch`);
    return 1;
  }
  const rows = rollup.map((entry) => {
    const name = String(entry.__typename === 'StatusContext' ? entry.context : entry.name);
    const started = Date.parse(String(entry.startedAt ?? ''));
    const finished = Date.parse(String(entry.completedAt ?? ''));
    const elapsed = Number.isFinite(started) && Number.isFinite(finished) ? `${Math.max(0, Math.round((finished - started) / 1000))}s` : '0';
    return { name, bucket: bucket(entry), elapsed, link: String(entry.detailsUrl ?? entry.targetUrl ?? '') };
  });
  deps.stdout(rows.map((row) => [row.name, row.bucket, row.elapsed, row.link].join('\t')).join('\n'));
  if (rows.some((row) => row.bucket === 'fail' || row.bucket === 'cancel')) return 1;
  return rows.some((row) => row.bucket === 'pending') ? 8 : 0;
}

// ---------------------------------------------------------------- diff

/**
 * `gh pr diff`, rebuilt from the pull request's files (the broker proxies JSON, not the diff media type).
 * Text changes match git's unified diff; a file GitHub gives no patch for (binary, very large) says so.
 */
export async function pullDiff(deps: AgentDeps, repo: string, number: number, nameOnly: boolean): Promise<string> {
  const files: ReturnType<typeof decodeFiles> = [];
  for (let page = 1; page <= 30; page++) {
    const batch = decodeFiles(await sessionBroker(deps).read(repo, `pulls/${number}/files?per_page=100&page=${page}`));
    files.push(...batch);
    if (batch.length < 100) break;
  }
  if (nameOnly) return files.map((file) => file.filename).join('\n');
  return files.map((file) => {
    const from = file.previous_filename ?? file.filename;
    const lines = [`diff --git a/${from} b/${file.filename}`];
    if (file.status === 'renamed') lines.push(`rename from ${from}`, `rename to ${file.filename}`);
    if (file.status === 'added') lines.push('new file mode 100644');
    if (file.status === 'removed') lines.push('deleted file mode 100644');
    if (file.patch === undefined || file.patch === null) {
      if (file.status !== 'renamed') lines.push(`Binary files ${file.status === 'added' ? '/dev/null' : `a/${from}`} and ${file.status === 'removed' ? '/dev/null' : `b/${file.filename}`} differ`);
      return lines.join('\n');
    }
    lines.push(`--- ${file.status === 'added' ? '/dev/null' : `a/${from}`}`, `+++ ${file.status === 'removed' ? '/dev/null' : `b/${file.filename}`}`, file.patch);
    return lines.join('\n');
  }).join('\n');
}

function decodeFiles(value: JsonValue) {
  return decodeBoundary(value, filesSchema);
}

// ---------------------------------------------------------------- lookup by head branch

/**
 * `gh pr list --head <branch>`: this Session publishes `<branch>` as `cloud/<host>/<branch>`, so both that
 * and the literal name are asked for (GitHub's `head=<owner>:<ref>` filter), newest first. The head is
 * matched again here, exactly, so an answer that ignored the filter can't leak other branches in.
 */
export async function pullsForHead(deps: AgentDeps, repo: string, branch: string, state: 'open' | 'closed' | 'all', limit: number): Promise<RestItem[]> {
  const name = branch.includes(':') ? branch.slice(branch.indexOf(':') + 1) : branch;
  const heads = new Set([name]);
  if (!name.startsWith('cloud/')) {
    const prefix = (await sessionBroker(deps).status().catch(() => null))?.caller?.branchPrefix;
    if (prefix) heads.add(`${prefix}${name}`);
  }
  const owner = repo.split('/')[0];
  const found = new Map<number, RestItem>();
  for (const head of heads) {
    const query = new URLSearchParams({ state, head: `${owner}:${head}`, per_page: String(Math.max(limit, 30)) });
    for (const pull of await listItems(deps, repo, `pulls?${query.toString()}`)) {
      const open = ghState(pull) === 'OPEN';
      if (heads.has(pull.head?.ref ?? '') && (state === 'all' || open === (state === 'open'))) found.set(pull.number, pull);
    }
  }
  return [...found.values()].sort((a, b) => b.number - a.number);
}

/** `cloud/<host>/<branch>` or `owner:branch` as given to --head: the Session-local branch name. */
export function localBranchName(head: string): string {
  const withoutOwner = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
  const parts = withoutOwner.split('/');
  return parts[0] === 'cloud' && parts.length >= 3 ? parts.slice(2).join('/') : withoutOwner;
}
