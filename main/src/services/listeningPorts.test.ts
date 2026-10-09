import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createListeningPortMonitor } from './listeningPorts';

const HTTP_SERVER = `require('http').createServer((_, res) => res.end('ok')).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
// Accepts connections and never answers, like a database waiting for its own protocol.
const SILENT_TCP_SERVER = `require('net').createServer(() => {}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
// Accepts one connection and stops listening, like `nc -l`.
const ONE_SHOT_SERVER = `const server = require('net').createServer(socket => { socket.destroy(); server.close(); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
// Starts an HTTP answer and sends one more header byte every 100 ms without finishing it.
const TRICKLING_SERVER = `require('net').createServer(socket => { socket.write('HTTP/1.1 200 OK\\r\\nX-Slow: '); setInterval(() => socket.write('a'), 100).unref(); socket.on('error', () => {}); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
const NOT_PANE = 2_147_483_000;

const children: ChildProcess[] = [];
const grandchildren: number[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const pid of grandchildren.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

async function startListener(source: string, stdin: 'ignore' | 'pipe' = 'ignore', executable = process.execPath): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(executable, ['-e', source], { stdio: [stdin, 'pipe', 'inherit'] });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', (chunk: Buffer) => resolve(Number.parseInt(chunk.toString(), 10)));
  });
  return { child, port };
}

/**
 * `nc -l`, or on Windows, which ships no nc, node copied to ncat.exe: there
 * netstat names no program and the process table supplies the name.
 */
async function startOneShotListener(): Promise<{ child: ChildProcess; port: number; name: string }> {
  if (process.platform === 'win32') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-ports-'));
    const ncat = path.join(dir, 'ncat.exe');
    await fs.copyFile(process.execPath, ncat);
    const listener = await startListener(ONE_SHOT_SERVER, 'ignore', ncat);
    listener.child.once('exit', () => void fs.rm(dir, { recursive: true, force: true }));
    return { ...listener, name: 'ncat' };
  }
  const port = await freePort();
  const child = spawn('nc', ['-l', String(port)], { stdio: 'ignore' });
  children.push(child);
  return { child, port, name: 'nc' };
}

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  // SAFETY: a TCP server listening on a port reports an AddressInfo.
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('exit', resolve));
}

// Each read runs lsof, ss or PowerShell, which takes seconds on a busy CI runner.
describe('listening port monitor', { timeout: 30_000 }, () => {
  it('lists a web server started from a Pane terminal under that Pane, and drops it once it stops', async () => {
    // The terminal's shell starts the server, as a user typing `npm run dev` would.
    const { child: shell, port } = await startListener(`require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(HTTP_SERVER)}], { stdio: 'inherit' });`);
    const monitor = createListeningPortMonitor({
      // Pane is an ancestor too; the nearer terminal decides.
      panePid: process.pid,
      terminalPanes: () => [{ pid: shell.pid ?? -1, sessionId: 'session-1', paneName: 'quick wins' }],
    });

    const listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
    if (listed?.pid) grandchildren.push(listed.pid);
    expect(listed).toMatchObject({
      port,
      process: 'node',
      group: 'pane-terminal',
      kind: 'web',
      sessionId: 'session-1',
      paneName: 'quick wins',
    });
    expect(listed?.pid).not.toBe(shell.pid);

    process.kill(listed?.pid ?? -1, 'SIGKILL');
    await exited(shell);
    expect((await monitor.refresh()).ports.some(entry => entry.port === port)).toBe(false);
  });

  it('relabels a slow server as web once it answers in time', async () => {
    // Holds every answer until told to go, like a dev server compiling its first page.
    const { child, port } = await startListener(`let ready = false; const waiting = []; process.stdin.once('data', () => { ready = true; waiting.splice(0).forEach(res => res.end('ok')); }); require('http').createServer((_, res) => ready ? res.end('ok') : waiting.push(res)).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`, 'pipe');
    const monitor = createListeningPortMonitor({ panePid: NOT_PANE, terminalPanes: () => [] });

    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.kind).toBe('tcp');
    child.stdin?.write('go\n');
    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.kind).toBe('web');
  });

  it('shows a renamed Pane under its new name', async () => {
    const { child, port } = await startListener(HTTP_SERVER);
    let paneName = 'quick wins';
    const monitor = createListeningPortMonitor({
      panePid: NOT_PANE,
      terminalPanes: () => [{ pid: child.pid ?? -1, sessionId: 'session-1', paneName }],
    });
    await monitor.refresh();

    paneName = 'docs pass';
    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.paneName).toBe('docs pass');
  });

  it('labels a port that does not answer HTTP as tcp, under Other apps', async () => {
    const { port } = await startListener(SILENT_TCP_SERVER);
    const monitor = createListeningPortMonitor({ panePid: NOT_PANE, terminalPanes: () => [] });

    const listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
    expect(listed).toMatchObject({ port, group: 'other', kind: 'tcp', process: 'node' });
  });

  it('lists a one-shot listener like nc as tcp without connecting to it', async () => {
    const { child, port, name } = await startOneShotListener();
    const monitor = createListeningPortMonitor({ panePid: NOT_PANE, terminalPanes: () => [] });

    let listed;
    for (let attempt = 0; attempt < 20 && !listed; attempt++) {
      listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
      if (!listed) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(listed).toMatchObject({ port, kind: 'tcp', process: name });
    // The listener exits after its first connection, so a probe would end it.
    expect(child.exitCode).toBeNull();
    expect((await monitor.refresh()).ports.some(entry => entry.port === port)).toBe(true);
  });

  it('labels a port that trickles an unfinished answer as tcp within the probe deadline', async () => {
    const { port } = await startListener(TRICKLING_SERVER);
    const monitor = createListeningPortMonitor({ panePid: NOT_PANE, terminalPanes: () => [] });

    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.kind).toBe('tcp');
  });

  it("puts ports opened by Pane's own process tree under Pane", async () => {
    const { port } = await startListener(HTTP_SERVER);
    const monitor = createListeningPortMonitor({ panePid: process.pid, terminalPanes: () => [] });

    const listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
    expect(listed).toMatchObject({ port, group: 'pane', kind: 'web' });
  });

  it('tells listeners when a port appears', async () => {
    const seen: number[][] = [];
    const monitor = createListeningPortMonitor({
      panePid: NOT_PANE,
      terminalPanes: () => [],
      onChange: snapshot => seen.push(snapshot.ports.map(entry => entry.port)),
    });
    await monitor.refresh();

    const { port } = await startListener(HTTP_SERVER);
    await monitor.refresh();

    expect(seen.at(-1)).toContain(port);
  });
});
