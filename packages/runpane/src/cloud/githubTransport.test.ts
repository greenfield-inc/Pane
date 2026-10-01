import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubApi } from './githubApi';
import { createGitHubRest } from './coordinator/github/rest';
import { githubErrorMessage, githubJsonRequest, type FetchLike } from './githubTransport';

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
  signal?: AbortSignal;
}

function fakeFetch(replies: { status: number; text?: string; headers?: [string, string][] }[]): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, ...init });
    const reply = replies.shift();
    assert.ok(reply, `unexpected request ${init.method} ${url}`);
    const headers = new Headers(reply.headers);
    return { status: reply.status, headers, text: async () => reply.text ?? '' };
  };
  return { fetchImpl, seen };
}

test('githubJsonRequest sends GitHub\'s headers, a JSON body and a timeout, and resolves any status', async () => {
  const { fetchImpl, seen } = fakeFetch([
    { status: 201, text: '{"id":7}' },
    { status: 404, text: '<html>not json</html>' },
    { status: 204 },
  ]);
  const created = await githubJsonRequest(fetchImpl, { method: 'POST', url: 'https://gh.test/repos/a/b/keys', token: 'tok', userAgent: 'ua', body: { title: 't', read_only: true } });
  assert.deepEqual([created.status, created.body], [201, { id: 7 }]);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer tok');
  assert.equal(seen[0].headers.get('accept'), 'application/vnd.github+json');
  assert.equal(seen[0].headers.get('x-github-api-version'), '2022-11-28');
  assert.equal(seen[0].headers.get('user-agent'), 'ua');
  assert.equal(seen[0].headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(seen[0].body ?? ''), { title: 't', read_only: true });
  assert.ok(seen[0].signal instanceof AbortSignal);

  const missing = await githubJsonRequest(fetchImpl, { method: 'GET', url: 'https://gh.test/x', token: 'tok', userAgent: 'ua' });
  assert.deepEqual([missing.status, missing.body], [404, undefined]);
  assert.equal(seen[1].headers.get('content-type'), null);
  assert.equal(seen[1].body, undefined);
  const empty = await githubJsonRequest(fetchImpl, { method: 'DELETE', url: 'https://gh.test/y', token: 'tok', userAgent: 'ua' });
  assert.deepEqual([empty.status, empty.body], [204, undefined]);
});

test('githubErrorMessage reads GitHub\'s {message, errors[]} and nothing else', () => {
  assert.equal(githubErrorMessage({ message: 'Validation Failed', errors: [{ message: 'key is already in use' }, 'raw'] }), 'Validation Failed (key is already in use; raw)');
  assert.equal(githubErrorMessage({ message: 'Not Found' }), 'Not Found');
  assert.equal(githubErrorMessage(undefined), null);
  assert.equal(githubErrorMessage(['x']), null);
});

test('the laptop client keeps its own status policy on the shared transport', async () => {
  const { fetchImpl, seen } = fakeFetch([
    { status: 204 },
    { status: 404, text: '{"message":"Not Found"}' },
    { status: 403, text: '{"message":"Must have admin rights to Repository."}' },
    { status: 422, text: '{"message":"Validation Failed","errors":[{"message":"key is already in use"}]}' },
  ]);
  const api = createGitHubApi('laptop-token', fetchImpl);
  assert.equal(await api.deleteDeployKey('acme/app', 5), true);
  assert.equal(await api.deleteDeployKey('acme/app', 5), false);
  await assert.rejects(api.deleteDeployKey('acme/app', 5), { name: 'GitHubApiError', status: 403, message: 'GitHub DELETE /repos/acme/app/keys/5 failed with HTTP 403: Must have admin rights to Repository.' });
  await assert.rejects(api.addDeployKey('acme/app', { title: 't', key: 'ssh-ed25519 AAAA', readOnly: true }), /HTTP 422: Validation Failed \(key is already in use\)/u);
  assert.equal(seen[0].url, 'https://api.github.com/repos/acme/app/keys/5');
  assert.equal(seen[0].headers.get('user-agent'), 'runpane-cloud');
  assert.deepEqual(JSON.parse(seen[3].body ?? ''), { title: 't', key: 'ssh-ed25519 AAAA', read_only: true });
});

test('the coordinator client keeps its own 2xx and rate-limit policy on the shared transport', async () => {
  const { fetchImpl, seen } = fakeFetch([
    { status: 201, text: '{"number":3}' },
    { status: 403, text: '{"message":"API rate limit exceeded"}', headers: [['x-ratelimit-remaining', '0']] },
    { status: 404, text: '{"message":"Not Found"}' },
  ]);
  const rest = createGitHubRest('https://gh.test/', fetchImpl);
  assert.deepEqual(await rest.request('POST', '/repos/a/b/issues', 'app-token', { title: 'x' }), { status: 201, body: { number: 3 } });
  assert.equal(seen[0].url, 'https://gh.test/repos/a/b/issues');
  assert.equal(seen[0].headers.get('user-agent'), 'runpane-cloud-coordinator');
  await assert.rejects(rest.request('GET', '/repos/a/b/issues?per_page=1', 'app-token'), { code: 'github-rate-limited' });
  await assert.rejects(rest.request('GET', '/repos/a/b/issues/9', 'app-token'), { code: 'github-error', message: 'GitHub GET /repos/a/b/issues/9 answered 404: Not Found' });
  const offline = createGitHubRest('https://gh.test', async () => {
    throw new Error('ECONNREFUSED');
  });
  await assert.rejects(offline.request('GET', '/x', 't'), { code: 'github-error', message: 'GitHub GET /x failed: ECONNREFUSED' });
});
