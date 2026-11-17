// The seeded hosts, for journeys.sh.
//
//   node fixture.mjs <perf-root> ids                          # shell assignments: HOST_A, HOST_B (the
//                                                             # proxied addresses the phone uses), PANE_A,
//                                                             # PANE_B, TERMINAL_A, SESSION_A, CHAT_A, APPROVAL_A
//   node fixture.mjs <perf-root> close-approvals                # close the seeded approvals still waiting
//   node fixture.mjs <perf-root> call <host> <channel> [json-args]   # one /invoke straight to the host
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [root, command, ...rest] = process.argv.slice(2);
const code = file => JSON.parse(Buffer.from(readFileSync(path.join(root, file), 'utf8').trim().slice('pane-remote://'.length), 'base64url'));

async function invoke(host, channel, ...args) {
  const { baseUrl, token } = code(`${host}.code`);
  const response = await fetch(`${baseUrl}/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args, runtimeId: 'pane-perf-ids', clientLabel: 'perf ids', requestId: `fixture-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}` }),
  });
  const body = await response.json();
  return body.result?.data ?? body.result;
}

if (command === 'call') {
  const [host, channel, args = '[]'] = rest;
  // Exit only after a large answer has flushed to a pipe.
  const answer = JSON.stringify(await invoke(host, channel, ...JSON.parse(args)));
  await new Promise(resolve => process.stdout.write(`${answer}\n`, resolve));
  process.exit(0);
}
if (command === 'close-approvals') {
  // Approvals whose asker went with a host restart; prime asks fresh ones.
  const waiting = (await invoke('hostA', 'notify:remote-snapshot')).items.filter(item => item.title.startsWith('Perf approval') && item.state === 'waiting');
  for (const item of waiting) await invoke('hostA', 'notify:remote-command', { type: 'close', id: item.id, reason: 'perf fixture primed again' });
  console.log(`${waiting.length} approvals closed`);
  process.exit(0);
}
if (command !== 'ids') {
  console.error('Usage: node fixture.mjs <perf-root> ids|close-approvals|call <host> <channel> [json-args]');
  process.exit(1);
}

// runpane lists live Panes only, so an archived perf-1 never stands in for the seeded one.
const runpaneCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/runpane/dist/cli.js');
const paneNamed = host => JSON.parse(execFileSync('node', [runpaneCli, 'panes', 'list', '--pane-dir', path.join(root, host), '--json'], { encoding: 'utf8', env: { ...process.env, HOME: path.join(root, 'home') } }))
  .panes.find(pane => pane.name === 'perf-1');
const paneA = paneNamed('hostA');
const paneB = paneNamed('hostB');
const terminal = (await invoke('hostA', 'panels:list', paneA.id)).find(panel => panel.type === 'terminal');
const session = (await invoke('hostA', 'orchestration-sessions:list')).sessions.find(candidate => candidate.name === 'perf-chat');
const chat = (await invoke('hostA', 'orchestration-sessions:get', { sessionId: session.id }, { chatTabs: true, chatAgents: true })).panel;
// The second seeded approval, so Next has one before and after it.
const approval = (await invoke('hostA', 'notify:remote-snapshot')).items.find(item => item.title === 'Perf approval 2: pick one' && item.state === 'waiting');

const ids = {
  HOST_A: code('hostA.phone-code').baseUrl,
  HOST_B: code('hostB.phone-code').baseUrl,
  PANE_A: paneA.id,
  PANE_B: paneB.id,
  TERMINAL_A: terminal.id,
  SESSION_A: session.id,
  CHAT_A: chat.id,
  APPROVAL_A: approval?.id ?? '',
};
for (const [key, value] of Object.entries(ids)) console.log(`${key}='${value}'`);
