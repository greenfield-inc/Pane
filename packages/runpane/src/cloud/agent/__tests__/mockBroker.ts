import { execFileSync } from 'node:child_process';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../../../boundaryDecoder';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * A stand-in for the coordinator's GitHub broker (coordinator/github/broker.ts): records every request and answers
 * with the documented shapes. Push bundles are checked with the real git (`git bundle list-heads`).
 */

export interface BrokerRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  body: JsonObject | null;
}

export interface MockBroker {
  baseUrl: string;
  requests: BrokerRequest[];
  /** Bundles received by /push, raw. */
  bundles: Buffer[];
  mode: 'app' | 'pat' | 'off';
  /** Answers for GET /cloud/github/read/<route> keyed by route (e.g. `pulls`, `issues/3`). */
  reads: Map<string, JsonValue>;
  /** Forced error answers keyed by `METHOD /path`. */
  failures: Map<string, { status: number; code: string; message: string }>;
  close(): Promise<void>;
}

export const HOST = 'rp-test-abc123';
export const READ_TOKEN = 'ghs_test_readonly_token';

export async function startMockBroker(options: { mode?: 'app' | 'pat' | 'off'; repos?: string[] } = {}): Promise<MockBroker> {
  const repos = options.repos ?? ['acme/widgets'];
  const state: Omit<MockBroker, 'baseUrl' | 'close'> = {
    requests: [], bundles: [], mode: options.mode ?? 'app', reads: new Map(), failures: new Map(),
  };
  let next = 40;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://broker');
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? decodeBoundary(JSON.parse(text), boundary.jsonObject) : null;
        state.requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, authorization: req.headers.authorization, body });
        const send = (status: number, payload: JsonValue) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const failure = state.failures.get(`${req.method} ${url.pathname}`);
        if (failure) return send(failure.status, { ok: false, code: failure.code, message: failure.message });
        const route = url.pathname.replace(/^\/cloud\/github\//u, '');
        if (req.method === 'GET' && route === 'status') {
          return send(200, {
            ok: true, mode: state.mode, app: state.mode === 'app' ? { id: 12345, slug: 'runpane-cloud-test', installationId: 4242 } : null,
            repos, allowReadyPulls: false, tokens: [], caller: { sessionId: 'sess123', host: HOST, namespace: `cloud/${HOST}/`, repos },
          });
        }
        if (req.method === 'POST' && route === 'token') {
          if (state.mode !== 'app') return send(409, { ok: false, code: 'read-token-unsupported', message: 'PAT mode has no read tokens' });
          return send(200, { ok: true, repo: body?.repo ?? null, token: READ_TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { contents: 'read', metadata: 'read' } });
        }
        if (req.method === 'POST' && route === 'push') {
          const bundle = Buffer.from(String(body?.bundle ?? ''), 'base64');
          state.bundles.push(bundle);
          const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-broker-'));
          try {
            await fs.writeFile(path.join(dir, 'b.bundle'), bundle);
            const heads = execFileSync('git', ['bundle', 'list-heads', path.join(dir, 'b.bundle')], { encoding: 'utf8' });
            const sha = heads.trim().split(/\s+/u)[0];
            const branch = `cloud/${HOST}/${String(body?.branch)}`;
            return send(200, { ok: true, repo: body?.repo ?? null, branch, ref: `refs/heads/${branch}`, sha, outcome: 'created', compareUrl: `https://github.com/${String(body?.repo)}/compare/main...${branch}` });
          } finally {
            await fs.rm(dir, { recursive: true, force: true });
          }
        }
        if (req.method === 'POST' && (route === 'pulls' || route === 'issues')) {
          const number = next++;
          return send(200, { ok: true, number, url: `https://github.com/${String(body?.repo)}/${route === 'pulls' ? 'pull' : 'issues'}/${number}`, state: 'open' });
        }
        const patch = /^(pulls|issues)\/(\d+)$/u.exec(route);
        if (req.method === 'PATCH' && patch) {
          return send(200, { ok: true, number: Number(patch[2]), url: `https://github.com/${String(body?.repo)}/${patch[1] === 'pulls' ? 'pull' : 'issues'}/${patch[2]}`, state: body?.state ?? 'open' });
        }
        if (req.method === 'POST' && route === 'comments') {
          return send(200, { ok: true, id: 9001, url: `https://github.com/${String(body?.repo)}/issues/${String(body?.number)}#issuecomment-9001` });
        }
        // v1: GET /cloud/github/read/<owner>/<name>/<path>; `reads` is keyed by <path>, the repo is checked.
        const read = /^read\/([^/]+\/[^/]+)\/(.+)$/u.exec(route);
        if (req.method === 'GET' && read) {
          if (!repos.includes(read[1]) && read[1] !== 'acme/other') return send(403, { ok: false, code: 'repo-not-allowed', message: `${read[1]} is not allowed` });
          return state.reads.has(read[2]) ? send(200, { ok: true, status: 200, data: state.reads.get(read[2]) ?? null }) : send(403, { ok: false, code: 'forbidden', message: `read ${read[2]} is not allowlisted` });
        }
        return send(404, { ok: false, code: 'not-found', message: `${req.method} ${url.pathname}` });
      })().catch((error: Error) => {
        res.writeHead(500);
        res.end(String(error));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listen() on a TCP port has resolved, so address() is an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    requests: state.requests,
    bundles: state.bundles,
    reads: state.reads,
    failures: state.failures,
    get mode() { return state.mode; },
    set mode(value) { state.mode = value; },
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
