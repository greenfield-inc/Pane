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

it('records descendants created during graceful close before their parent exits', async () => {
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const directory = mkdtempSync(join(tmpdir(), 'pane-acp-close-descendant-'));
  const pidFile = join(directory, 'child.pid');
  const script = `let buffer='';const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(m.method==='initialize')reply(m.id,{protocolVersion:1,agentCapabilities:{sessionCapabilities:{close:{}}}});if(m.method==='session/new')reply(m.id,{sessionId:'owned'});if(m.method==='session/close'){setTimeout(()=>{const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();},700);setTimeout(()=>reply(m.id,{}),1800);}}});process.stdin.on('end',()=>process.exit(0));`;
  let recordedDescendant = false;
  const runtime = new AcpProcess({ executable: process.execPath, args: ['-e', script], cwd: directory, env: process.env, generation: 1, save: identities => { if (existsSync(pidFile)) recordedDescendant ||= identities.some(identity => identity.pid === Number(readFileSync(pidFile, 'utf8'))); } });
  try {
    await runtime.start(); await runtime.session.initialize(); await runtime.session.create({ cwd: directory, mcpServers: [] });
    await runtime.release();
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(recordedDescendant).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await runtime.release();
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* Owned child already exited. */ } }
    rmSync(directory, { recursive: true, force: true });
  }
});
