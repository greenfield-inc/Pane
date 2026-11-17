// Seeds an isolated host for the mobile perf journeys (README.md beside this file; hosts.sh seed runs it):
// a repository with N Panes, one terminal past the 2,500-line cap, open approvals and a
// Session whose chat holds 200 messages. Every write goes to the host named by --pane-dir.
//
//   node seed.mjs --pane-dir <dir> --code <connection-code-file> --panes 68 [--approvals 7] [--chat] [--big-terminal]
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const runpaneCli = path.join(repoRoot, 'packages/runpane/dist/cli.js');

const { values: opts } = parseArgs({
  options: {
    'pane-dir': { type: 'string' },
    code: { type: 'string' },
    panes: { type: 'string', default: '10' },
    approvals: { type: 'string', default: '0' },
    chat: { type: 'boolean', default: false },
    'big-terminal': { type: 'boolean', default: false },
  },
});
const paneDir = opts['pane-dir'];
if (!paneDir || !opts.code) {
  console.error('Usage: node seed.mjs --pane-dir <dir> --code <connection-code-file> --panes <n> [--approvals <n>] [--chat] [--big-terminal]');
  process.exit(1);
}

const connection = decodeCode(readFileSync(opts.code, 'utf8'));

function decodeCode(code) {
  const body = code.trim().slice('pane-remote://'.length);
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

function runpane(...args) {
  const out = execFileSync('node', [runpaneCli, ...args, '--pane-dir', paneDir, '--json'], { encoding: 'utf8', env: process.env });
  return JSON.parse(out);
}

let requestCount = 0;
async function invoke(channel, ...args) {
  const response = await fetch(`${connection.baseUrl}/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args, runtimeId: 'pane-perf-seed', clientLabel: 'perf seed', requestId: `seed-${Date.now()}-${requestCount++}` }),
  });
  const body = await response.json();
  if (!body.ok || body.result?.success === false) throw new Error(`${channel} failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.result?.data ?? body.result;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A repository the Panes branch from.
const repoDir = path.join(paneDir, '..', `${path.basename(paneDir)}-repo`);
if (!existsSync(path.join(repoDir, '.git'))) {
  mkdirSync(repoDir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.email=perf@example.test', '-c', 'user.name=perf', ...args], { cwd: repoDir });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repoDir, 'README.md'), 'Perf fixture\n');
  git('add', '.');
  git('commit', '-qm', 'init');
}
runpane('repos', 'add', '--path', repoDir, '--name', 'perf-repo', '--yes');

const existing = new Set(runpane('panes', 'list').panes?.map(pane => pane.name) ?? []);
const panes = Number(opts.panes);
for (let index = 1; index <= panes; index += 1) {
  const name = `perf-${index}`;
  if (existing.has(name)) continue;
  runpane('panes', 'create', '--repo', repoDir, '--name', name, '--tool-command', 'bash --norc', '--no-focus', '--no-pinned', '--yes');
}
console.log(`${panes} Panes`);

if (opts['big-terminal']) {
  // 3,000 lines fills the 2,500-line scrollback the phone reads.
  const pane = runpane('panes', 'list').panes.find(candidate => candidate.name === 'perf-1');
  const panel = (await invoke('panels:list', pane.id)).find(candidate => candidate.type === 'terminal');
  // Panels start when first shown; start this one at an iPhone's terminal size.
  if ((await invoke('panels:checkInitialized', panel.id)) !== true) {
    await invoke('panels:initialize', panel.id, { sessionId: pane.id, cols: 46, rows: 40 });
    await sleep(2000);
  }
  // A plain prompt keeps this machine's user and host name out of screenshots.
  runpane('panels', 'input', '--panel', panel.id, '--text', "PS1='$ '; clear\r", '--yes');
  runpane('panels', 'input', '--panel', panel.id, '--text', 'for i in $(seq 1 3000); do echo "line $i of the perf fixture, long enough to wrap on a phone screen once or twice"; done\r', '--yes');
  console.log(`big terminal: ${panel.id} in perf-1`);
}

const approvals = Number(opts.approvals);
const livePanes = runpane('panes', 'list').panes;
for (let index = 1; index <= approvals; index += 1) {
  // Asked from a Pane's terminal, as agents ask, so the approval screen shows that Pane's tabs.
  const pane = livePanes.find(candidate => candidate.name === `perf-${index + 1}`);
  const panel = (await invoke('panels:list', pane.id)).find(candidate => candidate.type === 'terminal');
  // notify waits for an answer; the question stays open after this process stops waiting.
  const child = spawn('node', [runpaneCli, 'notify', '--ui', 'options', '--title', `Perf approval ${index}: pick one`, '--context', 'A seeded question for the mobile perf journeys.', '--choices', JSON.stringify([{ label: 'Yes', recommended: true }, { label: 'No' }]), '--pane-dir', paneDir, '--json'], { detached: true, stdio: 'ignore', env: { ...process.env, PANE_SESSION_ID: pane.id, PANE_PANEL_ID: panel.id } });
  child.unref();
  // hosts.sh down stops the waiting askers too.
  appendFileSync(path.join(paneDir, '..', `${path.basename(paneDir)}.notify.pids`), `${child.pid}\n`);
}
if (approvals) {
  await sleep(3000);
  console.log(`${approvals} approvals asked`);
}

if (opts.chat) {
  const sessions = (await invoke('orchestration-sessions:list')).sessions;
  let session = sessions.find(candidate => candidate.name === 'perf-chat');
  if (!session) {
    session = runpane('sessions', 'create', '--from-json', writeJson({ name: 'perf-chat', agent: 'claude' })).session;
  }
  const view = await invoke('orchestration-sessions:get', { sessionId: session.id }, { chatTabs: true, chatAgents: true });
  const panelId = view.panel.id;
  const count = async () => (await invoke('chat-tab:get', panelId, 0)).messageCount ?? 0;
  // The scripted agent answers each message with one reply: 100 sends make 200 messages.
  while ((await count()) < 200) {
    await invoke('chat-tab:send', panelId, { operationId: `seed-${Date.now()}`, text: `Message ${await count()} of the perf fixture. ${'Some words to give it a realistic length. '.repeat(3)}` });
    for (let wait = 0; wait < 100; wait += 1) {
      const state = await invoke('chat-tab:get', panelId, 0);
      if (state.status === 'idle' && !state.pendingDelivery) break;
      await sleep(100);
    }
  }
  console.log(`chat: ${await count()} messages in ${panelId}`);
}

function writeJson(value) {
  const file = path.join(paneDir, '..', 'perf-session.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}
