import net from 'net';
import tls from 'tls';
import type { Duplex } from 'stream';
import { parseComputerName, type ComputerName } from './computerNames';

export interface ComputerTlsServerOptions {
  id: string;
  domain: string;
  /** The current certificate and key; null until the first one is issued. */
  secureContext(): tls.SecureContext | null;
  /** The loopback port that serves a name, or null when nothing does (connection closed). */
  target(name: ComputerName): number | null;
  log?: (line: string) => void;
}

export interface ComputerTlsServer {
  /** Ends TLS on a client stream the relay passed along from `peer`, the client's IP address. */
  accept(stream: Duplex, peer: string): void;
  /** Listens for same-network clients; returns the bound port. */
  listen(port: number, host: string): Promise<number>;
  /**
   * The client IP behind a connection this server forwarded, from the address and port the target
   * listener saw; null for a connection it did not forward.
   */
  clientAddress(remoteAddress: string | undefined, remotePort: number | undefined): string | null;
  close(): Promise<void>;
}

/** Errors from software that is not a TLS client: plain HTTP, other protocols, port scanners. */
const PROBE_ERRORS = new Set(['ERR_SSL_HTTP_REQUEST', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ECONNRESET']);
const PROBE_SUMMARY_MS = 60 * 60_000;

/**
 * Ends client TLS with this computer's certificate and pipes the plain stream to the loopback
 * listener for the requested name, as Tailscale Serve's TLS-terminated forward does.
 */
export function createComputerTlsServer(options: ComputerTlsServerOptions): ComputerTlsServer {
  const open = new Set<Duplex>();
  /** The client IP for each forwarded connection, by the loopback port it comes from. */
  const clients = new Map<number, string>();
  let probes = 0;
  let probesSince = 0;
  const SNICallback = (servername: string, callback: (error: Error | null, context?: tls.SecureContext) => void) => {
    const context = parseComputerName(servername, options.id, options.domain) ? options.secureContext() : null;
    if (context) callback(null, context);
    else callback(new Error(`No certificate for ${servername}`));
  };
  const server = tls.createServer({ SNICallback, ALPNProtocols: ['http/1.1'] });

  const clientError = (error: Error & { code?: string }) => {
    if (!PROBE_ERRORS.has(error.code ?? '')) {
      options.log?.(`[relay] client TLS failed: ${error.message}`);
      return;
    }
    // Other software on the network probes the local port; one line an hour says how often.
    probes += 1;
    if (Date.now() - probesSince < PROBE_SUMMARY_MS) return;
    options.log?.(`[relay] ignored ${probes} connection${probes === 1 ? '' : 's'} that did not start TLS (${error.code}); phones always use TLS`);
    probes = 0;
    probesSince = Date.now();
  };

  // Node sets `servername` on server-side sockets from the ClientHello; its typings omit it.
  const forward = (socket: tls.TLSSocket & { servername?: string | false }, peer: string) => {
    const servername = socket.servername || '';
    const name = parseComputerName(servername, options.id, options.domain);
    const port = name ? options.target(name) : null;
    if (port === null) {
      socket.destroy();
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port });
    let localPort: number | undefined;
    // Before the piped bytes are flushed, so the target can look the client up on its first read.
    upstream.once('connect', () => {
      localPort = upstream.localPort;
      if (localPort !== undefined) clients.set(localPort, peer);
    });
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    socket.pipe(upstream).pipe(socket);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => {
      if (localPort !== undefined && clients.get(localPort) === peer) clients.delete(localPort);
      socket.destroy();
    });
  };

  // Same-network phones arrive from their own address. `pane-direct serve` pipes every direct-path
  // stream in from 127.0.0.1 and does not report the QUIC peer, so direct-path clients share one
  // pairing lockout: five wrong codes over the direct path pause direct pairing for 15 minutes,
  // while pairing through the relay and on the same network still works.
  server.on('secureConnection', (socket: tls.TLSSocket) => forward(socket, (socket.remoteAddress ?? '').replace(/^::ffff:/u, '')));
  server.on('tlsClientError', clientError);

  return {
    accept(stream, peer) {
      open.add(stream);
      stream.once('close', () => open.delete(stream));
      const socket = new tls.TLSSocket(stream, { isServer: true, SNICallback, ALPNProtocols: ['http/1.1'] });
      let secure = false;
      socket.once('secure', () => {
        secure = true;
        forward(socket, peer);
      });
      socket.on('error', (error) => {
        if (!secure) clientError(error);
        socket.destroy();
      });
      stream.resume();
    },
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          // SAFETY: a server listening on a host and port reports an AddressInfo.
          resolve((server.address() as net.AddressInfo).port);
        });
      });
    },
    clientAddress(remoteAddress, remotePort) {
      // Forwarded connections come from 127.0.0.1; any other address is not one of them.
      if (remotePort === undefined || remoteAddress?.replace(/^::ffff:/u, '') !== '127.0.0.1') return null;
      return clients.get(remotePort) ?? null;
    },
    close() {
      for (const stream of open) stream.destroy();
      return new Promise((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
    },
  };
}
