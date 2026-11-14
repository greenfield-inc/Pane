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
  /** Ends TLS on a client stream the relay passed along. */
  accept(stream: Duplex): void;
  /** Listens for same-network clients; returns the bound port. */
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Ends client TLS with this computer's certificate and pipes the plain stream to the loopback
 * listener for the requested name, as Tailscale Serve's TLS-terminated forward does.
 */
export function createComputerTlsServer(options: ComputerTlsServerOptions): ComputerTlsServer {
  const open = new Set<Duplex>();
  const server = tls.createServer({
    SNICallback: (servername, callback) => {
      const context = parseComputerName(servername, options.id, options.domain) ? options.secureContext() : null;
      if (context) callback(null, context);
      else callback(new Error(`No certificate for ${servername}`));
    },
    ALPNProtocols: ['http/1.1'],
  });
  // Node sets `servername` on server-side sockets from the ClientHello; its typings omit it.
  server.on('secureConnection', (socket: tls.TLSSocket & { servername?: string | false }) => {
    const servername = typeof socket.servername === 'string' ? socket.servername : '';
    const name = parseComputerName(servername, options.id, options.domain);
    const port = name ? options.target(name) : null;
    if (port === null) {
      socket.destroy();
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port });
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    socket.pipe(upstream).pipe(socket);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  server.on('tlsClientError', (error) => options.log?.(`[relay] client TLS failed: ${error.message}`));

  return {
    accept(stream) {
      open.add(stream);
      stream.once('close', () => open.delete(stream));
      server.emit('connection', stream);
      stream.resume();
    },
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
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
