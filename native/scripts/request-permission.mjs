// Queues a permission request on a dev host, the way Pane's MCP permission
// bridge does, so the app's approval flow can be tested without an agent.
// Usage: node scripts/request-permission.mjs <pane-dir> <pane-id> [command]
// Prints the host's answer once someone allows or denies it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [paneDir, paneId, command = 'rm -rf dist && pnpm build'] = process.argv.slice(2);
if (!paneDir || !paneId) {
  console.error('Usage: node scripts/request-permission.mjs <pane-dir> <pane-id> [command]');
  process.exit(1);
}

const socketDir = path.join(paneDir, 'sockets');
const socket = fs.readdirSync(socketDir).find(name => name.startsWith('pane-permissions-'));
if (!socket) {
  console.error(`No permission socket in ${socketDir}. Is the host running?`);
  process.exit(1);
}

const client = net.connect(path.join(socketDir, socket), () => {
  client.write(JSON.stringify({
    type: 'permission-request',
    requestId: `dev-${Date.now()}`,
    sessionId: paneId,
    toolName: 'Bash',
    input: { command, description: 'Clean and rebuild' },
  }));
  console.log('Request queued. Answer it in the app.');
});
client.on('data', data => {
  console.log(data.toString());
  client.end();
});
