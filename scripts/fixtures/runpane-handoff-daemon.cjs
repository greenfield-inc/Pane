// Disposable daemon boundary for the actual runpane CLI; never launches agents.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { getPaneDaemonEndpoint } = require(process.argv[2]);
const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const endpoint = getPaneDaemonEndpoint(config.paneDir);
if (endpoint.transport === 'unix') fs.mkdirSync(path.dirname(endpoint.path), { recursive: true });
const repo = { id: 7, name: 'receiver', path: config.repoPath, active: true, sessionCount: 0 };
const server = net.createServer(socket => {
  let pending = '';
  socket.on('error', () => {});
  socket.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const frame = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (frame.channel === 'daemon:events') {
        socket.write(JSON.stringify({ type: 'response', id: frame.id, ok: true, result: {} }) + '\n');
        continue;
      }
      fs.appendFileSync(config.log, JSON.stringify({ ...frame, paneDir: config.paneDir }) + '\n');
      let result;
      if (frame.channel === 'runpane:repos:list') {
        if (config.reposError) {
          socket.write(JSON.stringify({ type: 'response', id: frame.id, ok: false, error: config.reposError }) + '\n');
          continue;
        }
        result = { ok: true, repos: [repo] };
      }
      else if (frame.channel === 'runpane:panes:create') {
        if (config.createError) {
          socket.write(JSON.stringify({ type: 'response', id: frame.id, ok: false, error: { message: config.createError } }) + '\n');
          continue;
        }
        const item = { index: 0, ...config.item };
        if (item.ok) { item.pinned = false; item.warnings = []; }
        result = { ok: item.ok, repo, items: [item] };
      }
      else if (frame.channel === 'runpane:panes:list') {
        const owned = config.ownedPane ?? { id: 'sender-pane', worktreePath: config.repoPath };
        result = { ok: true, panes: [{ id: owned.id, paneId: owned.id, name: 'sender', status: 'running', agentStatus: 'idle',
          worktreePath: owned.worktreePath, repoId: 1, panelCount: 1, pinned: false, ownership: 'pane' }] };
      }
      else if (frame.channel === 'runpane:panels:create') {
        const request = frame.args[0];
        result = { ok: true, paneId: request.paneId, panelId: 'test-tab', title: 'Codex', active: false, focused: false,
          tool: { title: 'Codex', command: 'codex' }, initialInput: config.item.initialInput, warnings: [] };
      } else {
        socket.write(JSON.stringify({ type: 'response', id: frame.id, ok: false, error: { message: `Unexpected fixture channel: ${frame.channel}` } }) + '\n');
        continue;
      }
      socket.write(JSON.stringify({ type: 'response', id: frame.id, ok: true, result }) + '\n');
    }
  });
});
server.on('error', error => { fs.writeFileSync(config.ready, JSON.stringify({ error: error.message })); process.exit(1); });
server.listen(endpoint.path, () => fs.writeFileSync(config.ready, '{}'));
process.on('SIGTERM', () => server.close(() => {
  if (endpoint.transport === 'unix') fs.rmSync(path.dirname(endpoint.path), { recursive: true, force: true });
  process.exit();
}));
