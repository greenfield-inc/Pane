import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parsePortsManifest, readPortsManifest } from './manifest';

describe('parsePortsManifest', () => {
  it('reads version 1 with defaults for https_port and path', () => {
    expect(parsePortsManifest(JSON.stringify({
      version: 1,
      ports: [{ name: 'site', port: 8787, https_port: 8787, path: '/s/ultra-feedback' }, { name: 'api', port: 3000 }],
    }))).toEqual({
      kind: 'ok',
      ports: [{ name: 'site', port: 8787, httpsPort: 8787, path: '/s/ultra-feedback' }, { name: 'api', port: 3000, httpsPort: undefined, path: '/' }],
    });
  });

  it.each([
    ['no version', { ports: [] }, /version/u],
    ['another version', { version: 2, ports: [] }, /version/u],
    ['an unknown top-level key', { version: 1, ports: [], autoOpen: true }, /unknown key autoOpen/u],
    ['an unknown entry key (a typo)', { version: 1, ports: [{ name: 'a', port: 1, htps_port: 2 }] }, /unknown key htps_port/u],
    ['a bad name', { version: 1, ports: [{ name: 'Web App', port: 3000 }] }, /name/u],
    ['a port out of range', { version: 1, ports: [{ name: 'a', port: 70000 }] }, /port must be/u],
    ['https_port 443', { version: 1, ports: [{ name: 'a', port: 3000, https_port: 443 }] }, /443/u],
    ['a path without a slash', { version: 1, ports: [{ name: 'a', port: 3000, path: 'x' }] }, /path/u],
    ['duplicate names', { version: 1, ports: [{ name: 'a', port: 1 }, { name: 'a', port: 2 }] }, /duplicate name/u],
    ['duplicate ports', { version: 1, ports: [{ name: 'a', port: 1 }, { name: 'b', port: 1 }] }, /duplicate port/u],
  ])('refuses %s', (_label, manifest, error) => {
    const read = parsePortsManifest(JSON.stringify(manifest));
    expect(read.kind).toBe('invalid');
    expect(read.kind === 'invalid' ? read.error : '').toMatch(error);
  });

  it('refuses text that is not JSON', () => {
    expect(parsePortsManifest('{').kind).toBe('invalid');
  });
});

describe('readPortsManifest', () => {
  it('is absent without .runpane/ports.json and reads it when present', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-manifest-'));
    try {
      expect(readPortsManifest(repo)).toEqual({ kind: 'absent' });
      fs.mkdirSync(path.join(repo, '.runpane'));
      fs.writeFileSync(path.join(repo, '.runpane', 'ports.json'), '{"version":1,"ports":[{"name":"web","port":5173}]}');
      expect(readPortsManifest(repo)).toEqual({ kind: 'ok', ports: [{ name: 'web', port: 5173, httpsPort: undefined, path: '/' }] });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
