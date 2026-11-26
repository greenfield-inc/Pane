import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { isolatedPane, type IsolatedPane } from './isolatedPane';
import { launchWithScriptedAgent, seedChatSessions, withFakeClaude, type SeededChat } from './scriptedChats';
// SAFETY: the proxy is a plain ES module with JSDoc types; Playwright's loader imports it as is.
import { start as startLinkProxy } from '../scripts/flapping-link-proxy.mjs';

/**
 * Two isolated Panes on one computer, linked the way a desktop reaches another machine (T-116, D-288):
 *
 *   desktop (A) ──http+sse, paired token──▶ link proxy (latency, byte counts, cuts) ──▶ host (B)
 *
 * - Each Pane has its own PANE_DIR, Electron profile and HOME (isolatedPane), Workspaces and
 *   Tailscale off. Nothing reaches the real ~/.pane, a real machine or the network.
 * - B serves its remote API on 127.0.0.1 over plain HTTP (the loopback mode an SSH tunnel uses)
 *   and accepts one paired token. A saves B as a computer whose only route is the proxy, so
 *   every byte between them crosses the proxy and pays its latency.
 * - Chats on both run the scripted ACP agent, never a real agent.
 */

export const HOST_LABEL = 'rig-host';
const DESKTOP_CLIENT_ID = 'rig-desktop';

interface RigPane { pane: IsolatedPane; app: ElectronApplication; page: Page; sessions: SeededChat[] }
interface LinkProxy {
  port: number;
  bytes: () => { toTarget: number; toClient: number };
  resetBytes: () => void;
  forceDown: (ms?: number) => void;
  forceUp: (options?: { resume?: boolean }) => void;
  close: () => Promise<void>;
}
export interface Rig { host: RigPane; desktop: RigPane; proxy: LinkProxy; latencyMs: number; close: () => Promise<void> }

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP host and port reports an AddressInfo, never a pipe name or null.
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).status < 500;
  } catch {
    return false;
  }
}

/** Turns on B's remote API on a loopback port and pairs one token with it. */
async function serveRemote(page: Page, port: number, token: string): Promise<void> {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await page.evaluate(async ({ listenPort, record }) => {
    const host = await window.electronAPI.remoteDaemon.updateHostConfig({ enabled: true, listenHost: '127.0.0.1', listenPort, pairingRequired: true, allowInsecureHttpOnLoopback: true });
    if (!host.success) throw new Error(`Turning on the host's remote API failed: ${host.error}`);
    const paired = await window.electronAPI.remoteDaemon.upsertClientRecord(record);
    if (!paired.success) throw new Error(`Pairing the desktop's token failed: ${paired.error}`);
  }, { listenPort: port, record: { id: DESKTOP_CLIENT_ID, label: DESKTOP_CLIENT_ID, createdAt: new Date().toISOString(), tokenHash } });
  await expect.poll(() => answers(`http://127.0.0.1:${port}/health`), { message: `the host answers on 127.0.0.1:${port}`, timeout: 20_000 }).toBe(true);
}

/** Saves B on A as a computer reached only through the proxy. */
async function saveHost(page: Page, proxyPort: number, token: string): Promise<void> {
  await page.evaluate(async ({ baseUrl, secret, label }) => {
    const saved = await window.electronAPI.remoteDaemon.upsertConnectionProfile({ id: label, label, baseUrl, token: secret, transport: 'http+sse' });
    if (!saved.success) throw new Error(`Saving the host on the desktop failed: ${saved.error}`);
  }, { baseUrl: `http://127.0.0.1:${proxyPort}`, secret: token, label: HOST_LABEL });
}

export interface RigOptions {
  latencyMs: number;
  hostChats: Array<{ name: string; turns: number }>;
  desktopChats: Array<{ name: string; turns: number }>;
}

export async function startRig(baseURL: string | undefined, options: RigOptions): Promise<Rig> {
  const hostPane = isolatedPane('rig-host');
  const desktopPane = isolatedPane('rig-desktop');
  withFakeClaude(hostPane);
  withFakeClaude(desktopPane);
  const hostSessions = await seedChatSessions(hostPane, baseURL, options.hostChats);
  const desktopSessions = await seedChatSessions(desktopPane, baseURL, options.desktopChats);

  const token = randomBytes(32).toString('hex');
  const hostPort = await freePort();
  const opened: ElectronApplication[] = [];
  let proxy: LinkProxy | undefined;
  try {
    const host = await launchWithScriptedAgent(hostPane, baseURL);
    opened.push(host.app);
    await serveRemote(host.page, hostPort, token);
    proxy = await startLinkProxy({ targetHost: '127.0.0.1', targetPort: hostPort, manual: true, latencyMs: options.latencyMs });
    const desktop = await launchWithScriptedAgent(desktopPane, baseURL);
    opened.push(desktop.app);
    await saveHost(desktop.page, proxy.port, token);
    const link = proxy;
    return {
      host: { pane: hostPane, ...host, sessions: hostSessions },
      desktop: { pane: desktopPane, ...desktop, sessions: desktopSessions },
      proxy: link,
      latencyMs: options.latencyMs,
      close: async () => {
        for (const app of opened.reverse()) await app.close().catch(() => undefined);
        await link.close();
      },
    };
  } catch (error) {
    for (const app of opened.reverse()) await app.close().catch(() => undefined);
    await proxy?.close();
    throw error;
  }
}
