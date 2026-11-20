import http from 'http';
import type { AddressInfo } from 'net';

/** Let's Encrypt's answer to a new order once a domain has used its weekly certificates, retrying at `at`. */
export function letsEncryptLimit(at: Date): string {
  const when = at.toISOString().replace('T', ' ').replace(/\.\d+Z$/u, '');
  return `too many certificates (50) already issued for "runpane.net" in the last 168h0m0s, retry after ${when} UTC: see https://letsencrypt.org/docs/rate-limits/#new-certificates-per-registered-domain`;
}

/** An ACME server that registers any account and refuses every new order with `detail`, as Let's Encrypt did. */
export async function startRefusingCa(detail: string): Promise<{ directoryUrl: string; orders: () => number; close(): Promise<void> }> {
  let orders = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      // SAFETY: a server listening on a host and port reports an AddressInfo.
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      response.setHeader('Replay-Nonce', `nonce${Math.random().toString(36).slice(2)}`);
      if (request.url === '/dir') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` }));
      } else if (request.url === '/nonce') {
        response.end();
      } else if (request.url === '/account') {
        response.writeHead(201, { 'Content-Type': 'application/json', Location: `${base}/account/1` });
        response.end(JSON.stringify({ status: 'valid' }));
      } else if (request.url === '/order' && request.method === 'POST') {
        orders += 1;
        response.writeHead(429, { 'Content-Type': 'application/problem+json', 'Retry-After': '8177' });
        response.end(JSON.stringify({ type: 'urn:ietf:params:acme:error:rateLimited', detail, status: 429 }));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    // SAFETY: as above.
    directoryUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dir`,
    orders: () => orders,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
