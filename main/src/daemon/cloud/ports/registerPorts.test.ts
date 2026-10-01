import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from '../../commandRegistry';
import { registerSessionPortsHandlers } from './registerPorts';
import { localTarget, type ServeBackend, type ServeListener } from './tailscaleServe';

const HOST = 'rp-a1b2c3d4.tail-example.ts.net';

class FakeServe implements ServeBackend {
  entries = new Map<number, ServeListener>();
  calls: string[] = [];
  async self() {
    return { running: true, backendState: 'Running', dnsName: HOST };
  }
  async listeners() {
    return new Map(this.entries);
  }
  async applyWeb(scheme: 'https' | 'http', tailnetPort: number, localPort: number) {
    this.calls.push(`apply ${scheme} :${tailnetPort} -> ${localPort}`);
    this.entries.set(tailnetPort, { kind: 'web', scheme, proxy: localTarget(localPort) });
  }
  async remove(tailnetPort: number) {
    this.entries.delete(tailnetPort);
  }
  async certCached() {
    return true;
  }
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// A new Session: the bootstrap writes the marker after the daemon started (seen live on a fresh Session).
describe('registerSessionPortsHandlers when the Session marker appears after the daemon started', () => {
  let dir: string;
  let marker: string;
  let repo: string;
  let serve: FakeServe;
  let registry: PaneCommandRegistry;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-register-'));
    marker = path.join(dir, 'serve.json');
    repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.runpane'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.runpane', 'ports.json'), JSON.stringify({ version: 1, ports: [{ name: 'demo', port: 8787 }] }));
    serve = new FakeServe();
    registry = new PaneCommandRegistry();
    const handle = registerSessionPortsHandlers({
      commandRegistry: registry,
      panelIds: () => [],
      panelPid: () => undefined,
      paneIdOf: () => undefined,
      projectPaths: () => [repo],
      daemonPort: () => 42137,
      emit: () => undefined,
      log: () => undefined,
      serveRecordPath: marker,
      serve,
      statePath: path.join(dir, 'ports.json'),
      markerPollMs: 20,
    });
    stop = () => handle?.stop();
  });

  afterEach(() => {
    stop?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers not-a-Session before the marker, then lists, opens and runs the manifest without a restart', async () => {
    const before = await registry.invoke('runpane:ports:list', [{}]);
    expect(before).toMatchObject({ available: false });
    await expect(registry.invoke('runpane:ports:open', [{ port: 9000 }])).rejects.toMatchObject({ code: 'ERR_PORTS_UNAVAILABLE' });
    expect(serve.calls).toEqual([]);

    fs.writeFileSync(marker, '{"transport":"https","port":42137}');

    await until(() => serve.calls.includes(`apply https :8787 -> 8787`));
    const after = await registry.invoke('runpane:ports:list', [{}]);
    expect(after).toMatchObject({ available: true, host: HOST, ports: [{ name: 'demo', port: 8787, source: 'manifest', status: 'serving' }] });
    await expect(registry.invoke('runpane:ports:open', [{ port: 9000 }])).resolves.toMatchObject({ ok: true, port: { port: 9000 } });
  });
});
