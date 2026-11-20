import { createHmac, timingSafeEqual } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { boundary, decodeBoundary, type BoundarySchema, type JsonObject } from '../../../../../shared/validation/boundaryDecoder';

/** An EAB key as the relay hands it out: `hmacKey` in base64, as Google's Public CA API returns it. */
export interface ExternalAccountKey { keyId: string; hmacKey: string }

/** What the fake CA saw: each account registered (with the EAB key id it used), orders, and DNS-01 challenges answered. */
export interface IssuingCa {
  directoryUrl: string;
  accounts: () => { eabKeyId: string | null }[];
  orders: () => number;
  challenges: () => number;
  close(): Promise<void>;
}

const optionalString = boundary.optional(boundary.string);
const jwsSchema = boundary.object({ protected: optionalString, payload: optionalString, signature: optionalString });
const headerSchema = boundary.object({ jwk: boundary.optional(boundary.json), kid: optionalString });
const payloadSchema = boundary.object({
  onlyReturnExisting: boundary.optional(boundary.boolean),
  contact: boundary.optional(boundary.array(boundary.string)),
  externalAccountBinding: boundary.optional(jwsSchema),
  identifiers: boundary.optional(boundary.array(boundary.object({ value: boundary.string }))),
});

/** A JWS part (base64url JSON); the empty payload of a POST-as-GET decodes as `{}`. */
function decode<Value>(part: string | undefined, schema: BoundarySchema<Value>): Value {
  return decodeBoundary(part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : {}, schema);
}

/**
 * A small ACME server, as Google Trust Services works: it registers an account only with a contact
 * and a valid, unused EAB key from `externalAccountKeys`, passes DNS-01 challenges without looking, and answers
 * every finalized order with `certificate`. It checks no JWS signatures besides the EAB's.
 */
export async function startIssuingCa(options: { certificate: string; externalAccountKeys: ExternalAccountKey[] }): Promise<IssuingCa> {
  const unused = new Map(options.externalAccountKeys.map((key) => [key.keyId, key.hmacKey]));
  const accounts: { jwk: string; eabKeyId: string | null }[] = [];
  const authorizations = new Map<string, { value: string; wildcard: boolean; valid: boolean }>();
  let orders = 0;
  let challenges = 0;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      // SAFETY: a server listening on a host and port reports an AddressInfo.
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = request.url ?? '';
      const json = (status: number, body: JsonObject, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        response.end(JSON.stringify(body));
      };
      const problem = (status: number, type: string, detail: string) => {
        response.writeHead(status, { 'Content-Type': 'application/problem+json' });
        response.end(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail, status }));
      };
      response.setHeader('Replay-Nonce', `nonce${Math.random().toString(36).slice(2)}`);
      if (url === '/dir') {
        json(200, { newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order`, meta: { externalAccountRequired: true } });
        return;
      }
      if (url === '/nonce') {
        response.end();
        return;
      }
      const jws = decodeBoundary(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}, jwsSchema);
      const header = decode(jws.protected, headerSchema);
      const payload = decode(jws.payload, payloadSchema);
      if (url === '/account') {
        const jwk = JSON.stringify(header.jwk);
        const known = accounts.findIndex((account) => account.jwk === jwk);
        if (known >= 0) {
          json(200, { status: 'valid' }, { Location: `${base}/account/${known}` });
          return;
        }
        if (payload.onlyReturnExisting) {
          problem(400, 'accountDoesNotExist', 'No account exists with the provided key');
          return;
        }
        if (!payload.contact?.length) {
          problem(400, 'invalidContact', 'Accounts must have at least one contact.');
          return;
        }
        const binding = payload.externalAccountBinding ?? { protected: undefined, payload: undefined, signature: undefined };
        const keyId = decode(binding.protected, headerSchema).kid ?? '';
        const hmacKey = unused.get(keyId);
        const expected = hmacKey ? createHmac('sha256', Buffer.from(hmacKey, 'base64')).update(`${binding.protected ?? ''}.${binding.payload ?? ''}`).digest() : null;
        const signature = Buffer.from(binding.signature ?? '', 'base64url');
        if (!expected || expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
          problem(400, 'externalAccountRequired', 'A valid, unused external account binding is required');
          return;
        }
        unused.delete(keyId);
        accounts.push({ jwk, eabKeyId: keyId });
        json(201, { status: 'valid' }, { Location: `${base}/account/${accounts.length - 1}` });
        return;
      }
      if (/^\/account\/\d+$/u.test(url)) {
        json(200, { status: 'valid' });
        return;
      }
      if (url === '/order') {
        orders += 1;
        const identifiers = payload.identifiers ?? [];
        const urls = identifiers.map(({ value }, index) => {
          const id = `${orders}-${index}`;
          authorizations.set(id, { value: value.replace(/^\*\./u, ''), wildcard: value.startsWith('*.'), valid: false });
          return `${base}/authz/${id}`;
        });
        json(201, { status: 'pending', identifiers, authorizations: urls, finalize: `${base}/finalize/${orders}` }, { Location: `${base}/orders/${orders}` });
        return;
      }
      const authz = /^\/(authz|challenge)\/(.+)$/u.exec(url);
      if (authz) {
        const entry = authorizations.get(authz[2]);
        if (!entry) {
          problem(404, 'malformed', 'No such authorization');
          return;
        }
        const challenge = (valid: boolean) => ({ type: 'dns-01', url: `${base}/challenge/${authz[2]}`, token: `token${authz[2]}`, status: valid ? 'valid' : 'pending' });
        if (authz[1] === 'challenge') {
          // completeChallenge posts `{}`; a POST-as-GET posts an empty payload.
          if (jws.payload) {
            challenges += 1;
            entry.valid = true;
          }
          json(200, challenge(entry.valid));
          return;
        }
        json(200, { status: entry.valid ? 'valid' : 'pending', identifier: { type: 'dns', value: entry.value }, wildcard: entry.wildcard, challenges: [challenge(entry.valid)] });
        return;
      }
      if (/^\/(finalize|orders)\/\d+$/u.test(url)) {
        const id = url.split('/').pop();
        json(200, { status: 'valid', certificate: `${base}/certificate/${id}`, finalize: `${base}/finalize/${id}`, authorizations: [] }, { Location: `${base}/orders/${id}` });
        return;
      }
      if (url.startsWith('/certificate/')) {
        response.writeHead(200, { 'Content-Type': 'application/pem-certificate-chain' });
        response.end(options.certificate);
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    // SAFETY: as above.
    directoryUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dir`,
    accounts: () => accounts.map(({ eabKeyId }) => ({ eabKeyId })),
    orders: () => orders,
    challenges: () => challenges,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
