import type { RemoteSetupCommandRunner } from '../remote-setup-command';

/** One tailnet profile as `tailscale status --json` reports it on this machine. */
export interface FakeTailnet {
  name: string;
  suffix: string;
  ip: string;
}

export const TAILNET_A: FakeTailnet = { name: 'example.github', suffix: 'taila5e94c.ts.net', ip: '100.115.232.35' };
export const TAILNET_B: FakeTailnet = { name: 'bloomapi.org.github', suffix: 'tail3c2c57.ts.net', ip: '100.65.125.102' };

interface ServeConfig {
  TCP: Record<string, { HTTPS?: boolean; TCPForward?: string; TerminateTLS?: string }>;
  Web: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
}

interface FakeTailscaleCall {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * A scripted Tailscale CLI. Serve config belongs to the tailnet profile it was set on, like the
 * real one, so switching `tailnet` drops every handler until something re-applies it.
 */
export function createFakeTailscale(options: { machine?: string; cli?: string; tailnet?: FakeTailnet } = {}) {
  const machine = options.machine ?? 'parsa-devbox';
  const cli = options.cli ?? 'tailscale';
  const serveByTailnet = new Map<string, ServeConfig>();
  const calls: FakeTailscaleCall[] = [];
  const state = { tailnet: options.tailnet ?? TAILNET_A, serveFails: '', statusFails: '', backend: 'Running', serveIgnored: false, busyWrites: 0, serveStatusFails: '' };

  const dnsName = () => `${machine}.${state.tailnet.suffix}`;
  const serveConfig = (): ServeConfig => {
    const existing = serveByTailnet.get(state.tailnet.name);
    if (existing) return existing;
    const created: ServeConfig = { TCP: {}, Web: {} };
    serveByTailnet.set(state.tailnet.name, created);
    return created;
  };
  const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });

  const run: RemoteSetupCommandRunner = async (command, args, runOptions) => {
    calls.push({ command, args, env: runOptions?.env });
    if (command !== cli) return { ok: false, stdout: '', stderr: `spawn ${command} ENOENT` };
    if (args[0] === 'version') return ok('1.90.0\n');
    if (args[0] === 'ip') return ok(`${state.tailnet.ip}\nfd7a:115c:a1e0::1\n`);
    if (args.join(' ') === 'status --json') {
      if (state.statusFails) return { ok: false, stdout: '', stderr: state.statusFails };
      return ok(JSON.stringify({
        BackendState: state.backend,
        CertDomains: [dnsName()],
        Self: { DNSName: `${dnsName()}.`, TailscaleIPs: [state.tailnet.ip, 'fd7a:115c:a1e0::1'], UserID: 31, Tags: null },
        User: { 31: { LoginName: 'owner@example.com' } },
        CurrentTailnet: { Name: state.tailnet.name, MagicDNSSuffix: state.tailnet.suffix, MagicDNSEnabled: true },
      }));
    }
    if (args[0] !== 'serve') return { ok: false, stdout: '', stderr: `unknown command ${args.join(' ')}` };
    if (args.join(' ') === 'serve status --json') {
      if (state.serveStatusFails) return { ok: false, stdout: '', stderr: state.serveStatusFails };
      const config = serveConfig();
      return ok(Object.keys(config.TCP).length === 0 ? '{}\n' : JSON.stringify(config));
    }
    if (state.serveFails) return { ok: false, stdout: '', stderr: state.serveFails };
    if (state.busyWrites > 0) {
      state.busyWrites -= 1;
      return { ok: false, stdout: '', stderr: 'Another client is changing the serve config; please try again.' };
    }
    if (state.serveIgnored) return ok();
    const config = serveConfig();
    const tls = args.find(arg => arg.startsWith('--tls-terminated-tcp='));
    const https = args.find(arg => arg.startsWith('--https='));
    const mount = args.find(arg => arg.startsWith('--set-path='))?.split('=')[1];
    const target = args[args.length - 1];
    if (tls) {
      config.TCP[tls.split('=')[1]] = { TCPForward: `127.0.0.1:${target}`, TerminateTLS: dnsName() };
    } else if (https && target === 'off') {
      const port = https.split('=')[1];
      const handlers = config.Web[`${dnsName()}:${port}`]?.Handlers ?? {};
      // Like the real CLI, --set-path removes one mount; without it, every mount on the port.
      if (mount) delete handlers[mount];
      if (!mount || Object.keys(handlers).length === 0) {
        delete config.TCP[port];
        delete config.Web[`${dnsName()}:${port}`];
      }
    } else if (https) {
      const port = https.split('=')[1];
      config.TCP[port] = { HTTPS: true };
      const web = config.Web[`${dnsName()}:${port}`] ??= { Handlers: {} };
      web.Handlers[mount ?? '/'] = { Proxy: target };
    }
    return ok();
  };

  return {
    run,
    calls,
    dnsName,
    serveCalls: () => calls.filter(call => call.args[0] === 'serve' && call.args[1] !== 'status'),
    switchTailnet: (tailnet: FakeTailnet) => { state.tailnet = tailnet; },
    failServe: (stderr: string) => { state.serveFails = stderr; },
    /** Makes `status --json` fail, as it does when tailscaled is not running. */
    failStatus: (stderr: string) => { state.statusFails = stderr; },
    setBackendState: (backend: 'Running' | 'NeedsLogin' | 'Stopped' | 'Starting' | 'NeedsMachineAuth') => { state.backend = backend; },
    /** Makes `serve status --json` fail. */
    failServeStatus: (stderr: string) => { state.serveStatusFails = stderr; },
    /** The next `count` Serve changes fail as they do while another process writes the config. */
    busyServe: (count: number) => { state.busyWrites = count; },
    /** `serve --bg` reports success but changes nothing. */
    ignoreServe: () => { state.serveIgnored = true; },
    /** Sets a handler directly, as if `tailscale serve` was run outside Pane. */
    serveWorkspaceOnly: (port = 55555) => {
      const config = serveConfig();
      config.TCP['8443'] = { HTTPS: true };
      config.Web[`${dnsName()}:8443`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}/secret` } } };
    },
    serveRemoteForward: (listenPort: number) => {
      serveConfig().TCP['443'] = { TCPForward: `127.0.0.1:${listenPort}`, TerminateTLS: dnsName() };
    },
  };
}
