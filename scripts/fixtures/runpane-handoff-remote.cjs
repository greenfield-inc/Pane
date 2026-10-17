// A disposable stand-in for Pane on another machine, reached the way runpane reaches a workspace:
// HTTP POST /invoke. Machine exec and write act on a fake home folder on this machine; Pane
// commands answer from canned state. Never launches agents.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const windows = process.platform === 'win32';
const repo = { id: 7, name: 'receiver', path: config.repoPath, active: true, sessionCount: 0 };
const ready = { ok: true, condition: 'ready', matched: true, timedOut: false, elapsedMs: 1, state: { initialized: true } };
let receiverResume;

const resolveHome = (file) => (file.startsWith('~/') ? path.join(config.home, file.slice(2)) : file);

function exec(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = windows
      ? spawn('powershell.exe', ['-NoProfile', '-Command', command], { cwd: config.home, windowsHide: true })
      : spawn('sh', ['-c', command], { cwd: config.home });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs ?? 120000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ os: windows ? 'Windows' : 'Linux', shell: windows ? 'powershell' : 'sh', exitCode: 1, stdout, stderr: stderr + error.message });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ os: windows ? 'Windows' : 'Linux', shell: windows ? 'powershell' : 'sh', exitCode, stdout, stderr });
    });
  });
}

async function answer(channel, args) {
  switch (channel) {
    case 'runpane:machine:exec':
      return exec(args[0].command, args[0].timeoutMs);
    case 'runpane:machine:write': {
      const target = resolveHome(args[0].path);
      const bytes = Buffer.from(args[0].content, args[0].encoding ?? 'utf8');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      return { path: target, bytes: bytes.length };
    }
    case 'runpane:repos:list':
      return { ok: true, repos: [repo] };
    case 'runpane:panes:create': {
      const item = args[0].panes[0];
      receiverResume = item.resume;
      return { ok: true, repo, items: [{ ok: true, index: 0, name: item.name, pinned: false, warnings: [],
        sessionId: 'remote-pane', paneId: 'remote-pane', panelId: 'remote-tab', worktreePath: path.join(config.home, 'worktrees', item.name),
        readiness: ready }] };
    }
    case 'runpane:panels:list':
      return { ok: true, paneId: args[0].paneId, panels: [{ id: 'remote-tab', panelId: 'remote-tab', paneId: args[0].paneId, type: 'terminal',
        title: 'receiver', active: false, agentType: config.agent, resumeId: receiverResume, resumeSource: 'agent' }] };
    case 'runpane:panels:screen':
      return { ok: true, panelId: args[0].panelId, source: 'scrollback', limit: 400, returnedLineCount: 1, hasMore: false,
        text: config.screenText ?? '', state: { initialized: true }, composer: { isPresent: true, hasUndeliveredText: false } };
    case 'runpane:panels:submit':
      return { ok: true, panelId: args[0].panelId, inputBytes: args[0].input.length, enter: 'cr', sequenceName: 'enter-cr',
        verifiedSubmitted: true, delivery: { state: 'taken', evidence: 'transcript' }, sentAt: new Date().toISOString() };
    default:
      throw new Error(`Unexpected fixture channel: ${channel}`);
  }
}

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      fs.appendFileSync(`${config.log}.errors`, `${request.method} ${request.url} with an unreadable body (${body.length} bytes)
`);
      response.writeHead(400).end();
      return;
    }
    const { channel, args } = parsed;
    // Log the channel and a summary of its arguments; writes carry whole files.
    fs.appendFileSync(config.log, JSON.stringify({ channel, args: channel === 'runpane:machine:write'
      ? [{ path: args[0].path, encoding: args[0].encoding, length: args[0].content.length }] : args }) + '\n');
    let reply;
    try {
      reply = { ok: true, result: await answer(channel, args) };
    } catch (error) {
      reply = { ok: false, error: { message: error.message } };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
});
process.on('uncaughtException', (error) => {
  fs.appendFileSync(`${config.log}.errors`, `${error.stack}
`);
  process.exit(1);
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(config.ready, JSON.stringify({ port: server.address().port })));
process.on('SIGTERM', () => server.close(() => process.exit()));
