import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createListeningPortMonitor } from './listeningPorts';

const HTTP_SERVER = `require('http').createServer((_, res) => res.end('ok')).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
// Accepts connections and never answers, like a database waiting for its own protocol.
const SILENT_TCP_SERVER = `require('net').createServer(() => {}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
const NOT_PANE = 2_147_483_000;

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

async function startListener(source: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', (chunk: Buffer) => resolve(Number.parseInt(chunk.toString(), 10)));
  });
  return { child, port };
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
  it('lists a web server started in a Pane terminal under that Pane, and drops it once it stops', async () => {
    const { child, port } = await startListener(HTTP_SERVER);
    const monitor = createListeningPortMonitor({
      panePid: NOT_PANE,
      terminalPanes: () => [{ pid: child.pid ?? -1, sessionId: 'session-1', paneName: 'quick wins' }],
    });

    const listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
    expect(listed).toEqual({
      port,
      pid: child.pid,
      process: 'node',
      group: 'pane-terminal',
      kind: 'web',
      sessionId: 'session-1',
      paneName: 'quick wins',
    });

    child.kill('SIGKILL');
    await exited(child);
    expect((await monitor.refresh()).ports.some(entry => entry.port === port)).toBe(false);
  });

  it('relabels a slow server as web once it answers in time', async () => {
    // Answers its first request after 1.5 s, like a dev server compiling its first page.
    const { port } = await startListener(`let first = true; require('http').createServer((_, res) => { setTimeout(() => res.end('ok'), first ? 1500 : 0); first = false; }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`);
    const monitor = createListeningPortMonitor({ panePid: NOT_PANE, terminalPanes: () => [] });

    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.kind).toBe('tcp');
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.kind).toBe('web');
  });

  it('labels a port that does not answer HTTP as tcp, under Other apps', async () => {
    const { port } = await startListener(SILENT_TCP_SERVER);
    const monitor = createListeningPortMonitor({ panePid: NOT_PANE, terminalPanes: () => [] });

    const listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
    expect(listed).toMatchObject({ port, group: 'other', kind: 'tcp', process: 'node' });
  });

  // Windows ships no nc.
  it.skipIf(process.platform === 'win32')('lists a one-shot listener like nc as tcp without connecting to it', async () => {
    const port = await freePort();
    const child = spawn('nc', ['-l', String(port)], { stdio: 'ignore' });
    children.push(child);
    const monitor = createListeningPortMonitor({ panePid: NOT_PANE, terminalPanes: () => [] });

    let listed;
    for (let attempt = 0; attempt < 20 && !listed; attempt++) {
      listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
      if (!listed) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(listed).toMatchObject({ port, kind: 'tcp', process: 'nc' });
    // nc exits after its first connection closes, so a probe would end it.
    expect(child.exitCode).toBeNull();
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
