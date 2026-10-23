import { expect, it, vi } from 'vitest';
import { AcpProcess } from './acpProcess';
import { ArchiveProcessTracker, type ArchiveProcessIdentity } from '../archiveProcessTracker';

it('owns a real adapter process until its protocol and OS lifetime have both ended', async () => {
  let identities: ArchiveProcessIdentity[] = [];
  const runtime = new AcpProcess({
    executable: process.execPath,
    args: ['-e', `let buffer = ''; process.stdin.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\\n')) >= 0) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if (message.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1}})+'\\n'); } }); process.stdin.on('end', () => process.exit(0));`],
    cwd: process.cwd(), env: process.env, generation: 1,
    save: entries => { identities = structuredClone(entries); },
  });
  const refresh = ArchiveProcessTracker.prototype.refresh;
  let observations = 0;
  const slowObservation = vi.spyOn(ArchiveProcessTracker.prototype, 'refresh').mockImplementation(async function (this: ArchiveProcessTracker) {
    observations++;
    await new Promise(resolve => setTimeout(resolve, 600));
    await refresh.call(this);
  });
  try {
    await runtime.start();
    expect(identities.length).toBeGreaterThan(0);
    await runtime.session.initialize();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await runtime.release();
    expect(identities).toEqual([]);
    expect(observations).toBeLessThanOrEqual(4);
  } finally { slowObservation.mockRestore(); await runtime.release(); }
});
