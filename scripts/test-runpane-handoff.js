// runpane handoff: destination parsing and note validation, through the built package.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const dist = path.join(__dirname, '..', 'packages', 'runpane', 'dist');
const cli = path.join(dist, 'cli.js');
const { parseDestination, validateNote, noteTemplate, HANDOFF_SECTIONS } = require(path.join(dist, 'handoff.js'));

const posixReceiver = { skip: process.platform === 'win32' && 'controlled receiver executable uses a POSIX shebang' };

const machine = (name, self = false) => ({ name, dnsName: `${name}.tail.invalid`, os: 'macOS', online: true, ips: [], self });
const machines = [machine('workstation', true), machine('parsa-devbox'), machine('parsas-macbook-pro'), machine('parsas-macbook-air'), machine('build-server')];

test('freeform destinations name the harness, model, effort, and machine', () => {
  assert.deepEqual(parseDestination('codex gpt-5 high on parsas-macbook-pro', machines), {
    machine: 'parsas-macbook-pro', agent: 'codex', model: 'gpt-5', effort: 'high',
  });
  assert.deepEqual(parseDestination('claude opus on parsa-devbox wsl', machines), {
    machine: 'parsa-devbox', agent: 'claude', model: 'opus', wsl: true,
  });
  assert.deepEqual(parseDestination('cursor on this machine', machines), { machine: null, agent: 'cursor' });
  assert.deepEqual(parseDestination('cursor on workstation', machines), { machine: null, agent: 'cursor' });
  assert.deepEqual(parseDestination('Claude Opus, effort=xhigh, build', machines), {
    machine: 'build-server', agent: 'claude', model: 'opus', effort: 'xhigh',
  });
  assert.deepEqual(parseDestination('parsas-macbook-pro claude model=claude-opus-5-5', machines), {
    machine: 'parsas-macbook-pro', agent: 'claude', model: 'claude-opus-5-5',
  });
});

test('flags override the freeform text', () => {
  assert.deepEqual(parseDestination('codex on build-server', machines, { machine: 'parsas-macbook-pro', agent: 'claude', model: 'sonnet', effort: 'low' }), {
    machine: 'parsas-macbook-pro', agent: 'claude', model: 'sonnet', effort: 'low',
  });
  assert.deepEqual(parseDestination('', machines, { machine: 'parsas-macbook-pro', agent: 'codex' }), { machine: 'parsas-macbook-pro', agent: 'codex' });
});

test('unclear destinations fail with a message that says what to fix', () => {
  assert.throws(() => parseDestination('claude on parsas-macbook', machines), /matches several machines: parsas-macbook-pro, parsas-macbook-air/);
  assert.throws(() => parseDestination('opus on parsas-macbook-pro', machines), /Name the agent: claude, codex, or cursor/);
  assert.throws(() => parseDestination('claude codex on build-server', machines), /names two agents: claude and codex/);
  assert.throws(() => parseDestination('claude on toaster', machines), /No machine of yours on Tailscale is called "toaster"/);
  assert.throws(() => parseDestination('claude high low on build-server', machines), /names two efforts: high and low/);
});

const filled = (overrides = {}) => HANDOFF_SECTIONS
  .map((section) => `## ${section.heading}\n\n${overrides[section.heading] ?? `Something about ${section.heading.toLowerCase()}.`}\n`)
  .join('\n');

test('a note with every section filled in is valid', () => {
  assert.deepEqual(validateNote(`# Handoff: fix login\n\n${filled()}`), { ok: true, missing: [], empty: [] });
});

test('missing and unfilled sections are named', () => {
  const note = filled({ 'Open questions': '<!-- What the receiver must ask the person. -->', 'How to verify': '' })
    .replace(/## Git state[\s\S]*$/, '');
  assert.deepEqual(validateNote(note), { ok: false, missing: ['Git state'], empty: ['Open questions', 'How to verify'] });
});

test('"None" fills a section; headings match without regard to case or level', () => {
  const note = filled({ 'Open questions': 'None.' }).replace('## Next steps', '### next STEPS');
  assert.equal(validateNote(note).ok, true);
});

test('the template has every required section and fails validation until filled in', () => {
  const template = noteTemplate({ originMachine: 'parsa-devbox', branch: 'fix-login', head: '940acc5', remote: 'origin', pushed: true });
  for (const section of HANDOFF_SECTIONS) assert.match(template, new RegExp(`^## ${section.heading}$`, 'm'));
  assert.match(template, /^origin_machine: parsa-devbox$/m);
  assert.match(template, /openai\/codex/);
  const result = validateNote(template);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, []);
  assert.ok(result.empty.includes('Goal'));
});

test('runpane handoff --template prints the template', () => {
  const result = spawnSync(process.execPath, [cli, 'handoff', '--template'], {
    encoding: 'utf8', env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^## Next steps$/m);
});

 test('model and effort reject executable syntax from text and overrides', () => {
  for (const value of ['gpt-5;id', 'gpt-5$(id)', 'gpt-5`id`', 'gpt-5&echo']) {
    assert.throws(() => parseDestination(`codex model=${value} here`, machines), /model/i);
    assert.throws(() => parseDestination('codex here', machines, { model: value }), /model/i);
  }
  assert.throws(() => parseDestination('codex effort=high;id here', machines), /effort/i);
  assert.throws(() => parseDestination('codex here', machines, { effort: '$(id)' }), /effort/i);
});

const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'task'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'code.txt'), 'initial');
  git('add', '.'); git('commit', '-m', 'initial');
  git('init', '--bare', path.join(root, 'remote.git'));
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), 'remote.git/\n');
  git('remote', 'add', 'origin', path.join(root, 'remote.git')); git('push', '-u', 'origin', 'task');
  const env = { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1' };
  return { root, git, env, run: (...args) => spawnSync(process.execPath, [cli, 'handoff', 'codex here', '--note-file', 'note.md', '--json', ...args], { cwd: root, encoding: 'utf8', env }) };
}
for (const existing of [false, true]) test(`staged ${existing ? 'modified' : 'added'} note refuses push without changing index or HEAD`, (t) => {
  const f = fixture(t);
  if (existing) { fs.writeFileSync(path.join(f.root, 'note.md'), filled()); f.git('add', 'note.md'); f.git('commit', '-m', 'existing note'); f.git('push'); }
  fs.writeFileSync(path.join(f.root, 'note.md'), filled({ Goal: 'private marker' })); f.git('add', 'note.md');
  fs.writeFileSync(path.join(f.root, 'code.txt'), 'changed');
  const head = f.git('rev-parse', 'HEAD'); const index = f.git('write-tree');
  const result = f.run('--push');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /note is staged/i);
  assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(f.git('write-tree'), index);
  assert.equal(f.git('rev-parse', 'origin/task'), head);
});
test('an unstaged note is excluded from dry-run dirty count', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  f.git('add', 'note.md'); f.git('commit', '-m', 'note'); f.git('push');
  fs.appendFileSync(path.join(f.root, 'note.md'), '\nprivate');
  const result = f.run('--dry-run'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).git.dirty, 0);
});

function receiver(f, options = {}) {
  const bin = path.join(f.root, 'fake-bin'); fs.mkdirSync(bin);
  const log = path.join(f.root, 'receiver-args.jsonl');
  const file = path.join(bin, 'runpane');
  fs.writeFileSync(file, `#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.includes('--version')) console.log('2.4.165');
else if(args.includes('list')) console.log(JSON.stringify({repos:[{id:7,name:'receiver',path:${JSON.stringify(options.repoPath ?? f.root)}}]}));
else console.log(JSON.stringify({items:[${JSON.stringify(options.item ?? {ok:true,sessionId:'test-pane',panelId:'test-panel'})}]}));
`, { mode: 0o700 });
  f.env.PATH = `${bin}${path.delimiter}${f.env.PATH}`;
  f.env.HOME = path.join(f.root, 'home');
  fs.appendFileSync(path.join(f.root, '.git', 'info', 'exclude'), 'fake-bin/\nreceiver-args.jsonl\nhome/\n');
  return () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
}
test('receiver starts at immutable sender commit and uses selected local Pane directory', posixReceiver, (t) => {
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
  const head=f.git('rev-parse','HEAD');
  fs.writeFileSync(path.join(f.root,'code.txt'),'remote advances'); f.git('add','code.txt'); f.git('commit','-m','advance'); f.git('push'); f.git('reset','--hard',head);
  const args=receiver(f); const result=f.run('--pane-dir',path.join(f.root,'isolated pane'));
  assert.equal(result.status,0,result.stderr);
  const calls=args(); const create=calls.find(a=>a.includes('create')); const list=calls.find(a=>a.includes('list'));
  assert.equal(create[create.indexOf('--base')+1],head);
  for(const call of [create,list]) assert.equal(call[call.indexOf('--pane-dir')+1],path.join(f.root,'isolated pane'));
});

test('WSL is rejected before push, note transfer, or receiver launch', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty');
 const head=f.git('rev-parse','HEAD'); const result=spawnSync(process.execPath,[cli,'handoff','codex here wsl','--note-file','note.md','--push'],{cwd:f.root,encoding:'utf8',env:f.env});
 assert.notEqual(result.status,0); assert.match(result.stderr,/WSL handoff is not supported/); assert.equal(f.git('rev-parse','HEAD'),head);
});
test('local receiver preserves shell metacharacters and multiword prompts as argv', posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const calls=receiver(f);
 const selected=path.join(f.root, "Jane Doe's pane & echo injected"); const result=f.run('--pane-dir',selected);
 assert.equal(result.status,0,result.stderr); const create=calls().find(a=>a.includes('create'));
 assert.equal(create[create.indexOf('--pane-dir')+1],selected);
 assert.match(create[create.indexOf('--prompt')+1],/^Read the handoff note at .* and continue the work it describes/);
});

test('dry-run with --push leaves HEAD, index, remote and destination untouched', posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty');
 receiver(f); const head=f.git('rev-parse','HEAD'); const index=f.git('write-tree'); const status=f.git('status','--porcelain');
 const result=f.run('--push','--dry-run'); assert.equal(result.status,0,result.stderr);
 assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('write-tree'),index); assert.equal(f.git('rev-parse','origin/task'),head); assert.equal(f.git('status','--porcelain'),status);
 assert.equal(fs.existsSync(path.join(f.root,'receiver-args.jsonl')),false); assert.equal(fs.existsSync(path.join(f.root,'home')),false);
});
test('failed sender push prevents note transfer and receiver discovery', posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty'); receiver(f);
 fs.writeFileSync(path.join(f.root,'remote.git','hooks','pre-receive'),'#!/bin/sh\nexit 1\n',{mode:0o700});
 const result=f.run('--push'); assert.notEqual(result.status,0); assert.equal(fs.existsSync(path.join(f.root,'receiver-args.jsonl')),false); assert.equal(fs.existsSync(path.join(f.root,'home')),false);
});
test('failed destination fetch prevents note transfer and launch', posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const calls=receiver(f);
 f.git('remote','set-url','origin',path.join(f.root,'missing.git'));
 // Keep receiver remote identity equal to sender while making fetch unavailable.
 const result=f.run(); assert.notEqual(result.status,0); assert.match(result.stderr,/git fetch failed/);
 assert.equal(calls().some(a=>a.includes('create')),false); assert.equal(fs.existsSync(path.join(f.root,'home')),false);
});
test('failed note write prevents agent launch', posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const calls=receiver(f); fs.mkdirSync(f.env.HOME,{recursive:true}); fs.writeFileSync(path.join(f.env.HOME,'.pane'),'not a directory');
 const result=f.run(); assert.notEqual(result.status,0); assert.match(result.stderr,/ENOTDIR|not a directory/); assert.equal(calls().some(a=>a.includes('list')),true); assert.equal(calls().some(a=>a.includes('create')),false);
});
test('partial receiver failure names sent note and created Pane for recovery', posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); receiver(f,{item:{ok:false,sessionId:'partial-pane',panelId:'partial-panel',error:{message:'agent readiness failed'}}});
 const result=f.run(); assert.notEqual(result.status,0); assert.match(result.stderr,/agent readiness failed/); assert.match(result.stderr,/partial-pane/); assert.match(result.stderr,/handoffs.*\.md/); assert.match(result.stderr,/agents status/);
});

for (const staged of [true, false]) test(`two-dot note ${staged ? 'staged refuses push' : 'unstaged stays out of push'}`, staged ? {} : posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'..handoff.md'),filled({Goal:'private two-dot marker'}));
 if(staged) f.git('add','..handoff.md');
 fs.writeFileSync(path.join(f.root,'code.txt'),'changed'); if(!staged) receiver(f);
 const head=f.git('rev-parse','HEAD'); const index=f.git('write-tree');
 const result=f.run('--note-file','..handoff.md','--push');
 if(staged) {
  assert.notEqual(result.status,0); assert.match(result.stderr,/note is staged/i);
  assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('write-tree'),index); assert.equal(f.git('rev-parse','origin/task'),head);
 } else {
  assert.equal(result.status,0,result.stderr);
  assert.equal(f.git('show','origin/task:code.txt'),'changed');
  assert.equal(f.git('ls-tree','--name-only','origin/task').includes('..handoff.md'),false);
  assert.equal(f.git('diff','--cached','--name-only'), '');
  assert.equal(fs.readFileSync(path.join(f.root,'..handoff.md'),'utf8').includes('private two-dot marker'),true);
 }
});

test('same-second handoffs preserve both receiving notes', posixReceiver, (t) => {
 const f=fixture(t); receiver(f);
 const clock=path.join(f.root,'fixed-clock.cjs');
 fs.writeFileSync(clock,"const RealDate=Date; global.Date=class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-05T12:00:00.000Z'])); } };\n");
 f.git('add','fixed-clock.cjs'); f.git('commit','-m','clock fixture'); f.git('push');
 f.env.NODE_OPTIONS=`--require=${clock}`;
 const paths=[];
 for(const goal of ['first private body','second private body']) {
  fs.writeFileSync(path.join(f.root,'note.md'),filled({Goal:goal}));
  const result=f.run(); assert.equal(result.status,0,result.stderr);
  const notes=fs.readdirSync(path.join(f.env.HOME,'.pane','handoffs'));
  paths.push(notes.find(n=>fs.readFileSync(path.join(f.env.HOME,'.pane','handoffs',n),'utf8').includes(goal)));
 }
 assert.ok(paths[0]); assert.ok(paths[1]); assert.notEqual(paths[0],paths[1]);
 assert.equal(fs.readFileSync(path.join(f.env.HOME,'.pane','handoffs',paths[0]),'utf8').includes('first private body'),true);
});

test('Cursor effort fails before Git or receiver side effects', posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty'); receiver(f);
 const head=f.git('rev-parse','HEAD'); const index=f.git('write-tree');
 for(const args of [['cursor high here'],['cursor here','--effort','high']]) {
  const result=spawnSync(process.execPath,[cli,'handoff',...args,'--note-file','note.md','--push'],{cwd:f.root,encoding:'utf8',env:f.env});
  assert.notEqual(result.status,0); assert.match(result.stderr,/Cursor.*effort.*not supported/i);
  assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('write-tree'),index); assert.equal(f.git('rev-parse','origin/task'),head);
  assert.equal(fs.existsSync(path.join(f.root,'receiver-args.jsonl')),false); assert.equal(fs.existsSync(f.env.HOME),false);
 }
});

test('repository selector with mismatched remote gives actionable matching-remote guidance', posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
 const clone=path.join(f.root,'other-clone'); fs.mkdirSync(clone);
 execFileSync('git',['init',clone],{stdio:'ignore'}); execFileSync('git',['-C',clone,'remote','add','origin','https://github.com/example/other.git']);
 f.git('config','status.showUntrackedFiles','no'); const calls=receiver(f,{repoPath:clone});
 const result=f.run('--repo','receiver'); assert.notEqual(result.status,0);
 assert.match(result.stderr,/Add a matching Git remote/); assert.doesNotMatch(result.stderr,/or pass --repo/);
 assert.equal(calls().some(a=>a.includes('create')),false); assert.equal(fs.existsSync(f.env.HOME),false);
});

test('remote PowerShell sends prompt and tool command through a JSON request file', posixReceiver, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
 const bin=path.join(f.root,'fake-tailnet'); fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,'tailscale'),`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({BackendState:'Running',Self:{DNSName:'sender.invalid',OS:'linux',UserID:1},Peer:{remote:{DNSName:'receiver.invalid',OS:'windows',UserID:1,Online:true}}}))});`,{mode:0o700});
 f.env.PATH=`${bin}${path.delimiter}${f.env.PATH}`;
 const log=path.join(f.root,'transport.jsonl'); const preload=path.join(f.root,'transport.cjs');
 fs.writeFileSync(preload,`const fs=require('node:fs');const daemon=require(${JSON.stringify(path.join(dist,'daemonClient.js'))});
 daemon.invokeRemoteDaemon=async(target,channel,args)=>{
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({channel,args})+'\\n');
 if(channel==='runpane:machine:write')return {path:'C:/Users/Jane Doe/handoffs/'+args[0].path.split('/').pop()};
 const command=args[0].command;let stdout='';
 if(command.includes('--version'))stdout='2.4.165';
 else if(command.includes('repos')&&command.includes('list'))stdout=JSON.stringify({repos:[{id:7,name:'receiver',path:'C:/Users/Jane Doe/repo'}]});
 else if(command.includes('remote -v'))stdout='origin '+${JSON.stringify(f.git('remote','get-url','origin'))}+' (fetch)';
 else if(command.includes('panes')&&command.includes('create'))stdout=JSON.stringify({items:[{ok:true,sessionId:'test',panelId:'panel'}]});
 return {shell:'powershell.exe',exitCode:0,stdout,stderr:''};};`);
 f.env.NODE_OPTIONS=`--require=${preload}`;
 const result=f.run('--machine','receiver','--model','gpt-5','--effort','high'); assert.equal(result.status,0,result.stderr);
 const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 const requestWrite=calls.find(c=>c.channel==='runpane:machine:write'&&c.args[0].path.endsWith('.json'));
 assert.ok(requestWrite,'create request must be written as JSON before invoking PowerShell');
 const request=JSON.parse(requestWrite.args[0].content); const pane=request.panes[0];
 assert.equal(pane.baseBranch,f.git('rev-parse','HEAD')); assert.equal(request.waitReady,true); assert.equal(request.noFocus,true);
 assert.match(pane.tool.initialInput, /"Receiver instructions"/); assert.match(pane.tool.command,/model_reasoning_effort=high/);
 assert.equal(request.associateSession,undefined);
 const create=calls.find(c=>c.channel==='runpane:machine:exec'&&c.args[0].command.includes('panes create'));
 assert.match(create.args[0].command,/--from-json/); assert.doesNotMatch(create.args[0].command,/--prompt|--tool-command|Receiver instructions/);
});

test('note through a directory alias stays protected in the canonical Git checkout', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); f.git('add','note.md'); f.git('commit','-m','existing note'); f.git('push');
 const alias=f.root+'-alias'; fs.symlinkSync(f.root,alias,'junction'); t.after(()=>fs.rmSync(alias,{recursive:true,force:true}));
 fs.appendFileSync(path.join(f.root,'note.md'),'\nprivate alias marker'); f.git('add','note.md');
 const aliasDry=f.run('--note-file',path.join(alias,'note.md'),'--dry-run'); assert.equal(aliasDry.status,0,aliasDry.stderr); assert.equal(JSON.parse(aliasDry.stdout).git.dirty,0);
 fs.writeFileSync(path.join(f.root,'code.txt'),'dirty');
 const head=f.git('rev-parse','HEAD'); const index=f.git('write-tree');
 const pushed=f.run('--note-file',path.join(alias,'note.md'),'--push');
 assert.notEqual(pushed.status,0); assert.match(pushed.stderr,/note is staged/);
 assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('write-tree'),index); assert.equal(f.git('rev-parse','origin/task'),head);
 f.git('restore','--staged','--','note.md'); f.git('restore','--','code.txt');
 const dry=f.run('--note-file',path.join(alias,'note.md'),'--dry-run'); assert.equal(dry.status,0,dry.stderr); assert.equal(JSON.parse(dry.stdout).git.dirty,0);
});
