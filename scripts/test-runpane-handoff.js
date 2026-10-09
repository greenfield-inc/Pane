// runpane handoff: destination parsing and note validation, through the built package.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const dist = path.join(__dirname, '..', 'packages', 'runpane', 'dist');
const cli = path.join(dist, 'cli.js');
const { parseDestination, validateNote, noteTemplate, HANDOFF_SECTIONS } = require(path.join(dist, 'handoff.js'));


const machine = (name, self = false) => ({ name, dnsName: `${name}.tail.invalid`, os: 'macOS', online: true, ips: [], self, owner: 'parsa@github', mine: true });
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
  assert.throws(() => parseDestination('claude on toaster', machines), /No machine on your tailnet is called "toaster"/);
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

test('runpane handoff --template prints the template', (t) => {
  const result = fixture(t).run('--template');
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
  const env = { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1', HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), PANE_DIR: path.join(root, 'isolated-data'), GIT_CONFIG_GLOBAL: path.join(root, '.git', 'isolated-global-config'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PANE_SESSION_ID', 'PANE_PANEL_ID', 'PANE_ORCHESTRATION_SESSION_ID', 'FOOZOL_DIR', 'NODE_OPTIONS']) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'task'); fs.writeFileSync(env.GIT_CONFIG_GLOBAL, ''); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'code.txt'), 'initial');
  git('add', '.'); git('commit', '-m', 'initial');
  git('init', '--bare', path.join(root, 'remote.git'));
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), 'remote.git/\n');
  git('remote', 'add', 'origin', path.join(root, 'remote.git')); git('push', '-u', 'origin', 'task');
  // Tailnet discovery is an external boundary, independent of the host's installed apps.
  const preload = path.join(root, '.git', 'isolated-tailnet.cjs');
  fs.writeFileSync(preload, `const cp=require('node:child_process');const spawn=cp.spawn;cp.spawn=(command,args,options)=>command==='runpane'?spawn(process.execPath,[${JSON.stringify(cli)},...args],options):spawn(command,args,options);require(${JSON.stringify(path.join(dist, 'workspace.js'))}).readTailnet = async () => ({ok:false,machines:[]});\n`);
  env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  return { t, root, git, env, run: (...args) => spawnSync(process.execPath, [cli, 'handoff', 'codex here', '--note-file', 'note.md', '--json', ...args], { cwd: root, encoding: 'utf8', env }) };
}
for (const existing of [false, true]) test(`staged ${existing ? 'modified' : 'added'} note refuses push without changing index or HEAD`, (t) => {
  const f = fixture(t);
  receiver(f);
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
  const f = fixture(t); receiver(f); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  f.git('add', 'note.md'); f.git('commit', '-m', 'note'); f.git('push');
  fs.appendFileSync(path.join(f.root, 'note.md'), '\nprivate');
  const result = f.run('--dry-run'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).git.dirty, 0);
});

function receiver(f, options = {}) {
  const { spawn } = require('node:child_process');
  const bin = path.join(f.root, 'fake-bin'); fs.mkdirSync(bin);
  const log = path.join(f.root, 'receiver-args.jsonl');
  const ready = path.join(bin, 'ready.json');
  const config = path.join(bin, 'daemon.json');
  const paneDir = options.paneDir ?? f.env.PANE_DIR;
  fs.writeFileSync(config, JSON.stringify({ paneDir, log, ready, repoPath: options.repoPath ?? f.root,
    createError: options.createError, reposError: options.reposError, ownedPane: options.ownedPane, item: options.item ?? { ok: true, sessionId: 'test-pane', panelId: 'test-panel', initialInput:{delivered:true,submitted:true,inputBytes:20,verifiedSubmitted:true,delivery:{state:'taken',evidence:'transcript'}} } }));
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'runpane-handoff-daemon.cjs'),
    path.join(dist, 'daemonClient.js'), config], { env: f.env, stdio: 'ignore' });
  f.t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  assert.ok(fs.existsSync(ready), 'isolated daemon starts');
  assert.deepEqual(JSON.parse(fs.readFileSync(ready, 'utf8')), {});
  fs.appendFileSync(path.join(f.root, '.git', 'info', 'exclude'), 'fake-bin/\nreceiver-args.jsonl\nhome/\n');
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  calls.stop = async () => { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; };
  return calls;
}
test('receiver starts at immutable sender commit and uses selected local Pane directory', (t) => {
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
  const head=f.git('rev-parse','HEAD');
  fs.writeFileSync(path.join(f.root,'code.txt'),'remote advances'); f.git('add','code.txt'); f.git('commit','-m','advance'); f.git('push'); f.git('reset','--hard',head);
  const selected=path.join(f.root,'isolated pane'); const args=receiver(f,{paneDir:selected}); const result=f.run('--pane-dir',selected);
  assert.equal(result.status,0,result.stderr);
  const calls=args(); const create=calls.find(a=>a.channel==='runpane:panes:create'); const list=calls.find(a=>a.channel==='runpane:repos:list');
  assert.equal(create.args[0].panes[0].baseBranch,head);
  for(const call of [create,list]) assert.equal(call.paneDir,path.join(f.root,'isolated pane'));
});

test('a handoff on this machine from inside a Pane opens the receiver as a tab in that Pane, not a new Pane', (t) => {
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
  const calls=receiver(f); f.env.PANE_SESSION_ID='sender-pane';
  const result=f.run();
  assert.equal(result.status,0,result.stderr);
  assert.equal(calls().some(a=>a.channel==='runpane:panes:create'),false);
  const tab=calls().find(a=>a.channel==='runpane:panels:create');
  assert.equal(tab.args[0].paneId,'sender-pane');
  assert.match(tab.args[0].tool.initialInput,/^Read the handoff note at .* and continue the work it describes/);
  assert.equal(JSON.parse(result.stdout).receiver.route,'tab');
});

test('a handoff from a Pane that does not own this checkout gets its own Pane and says why', (t) => {
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
  const calls=receiver(f,{ownedPane:{id:'sender-pane',worktreePath:path.join(os.tmpdir())}}); f.env.PANE_SESSION_ID='sender-pane';
  const result=f.run();
  assert.equal(result.status,0,result.stderr);
  assert.equal(calls().some(a=>a.channel==='runpane:panels:create'),false);
  assert.ok(calls().some(a=>a.channel==='runpane:panes:create'));
  const out=JSON.parse(result.stdout); assert.equal(out.receiver.route,'new-pane'); assert.match(out.receiver.reason,/does not own .* so the receiver gets its own new Pane/);
});

test('WSL is rejected before push, note transfer, or receiver launch', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty');
 const head=f.git('rev-parse','HEAD'); const result=spawnSync(process.execPath,[cli,'handoff','codex here wsl','--note-file','note.md','--push'],{cwd:f.root,encoding:'utf8',env:f.env});
 assert.notEqual(result.status,0); assert.match(result.stderr,/Handoff to a WSL receiver is not supported/); assert.equal(f.git('rev-parse','HEAD'),head);
});
test('local receiver preserves shell metacharacters and multiword prompts as argv', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const selected=path.join(f.root, "Jane Doe's pane & echo injected"); const calls=receiver(f,{paneDir:selected});
 const result=f.run('--pane-dir',selected);
 assert.equal(result.status,0,result.stderr); const create=calls().find(a=>a.channel==='runpane:panes:create');
 assert.equal(create.paneDir,selected);
 assert.match(create.args[0].panes[0].tool.initialInput,/^Read the handoff note at .* and continue the work it describes/);
});

test('dry-run with --push leaves HEAD, index, remote and destination untouched', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty');
 const calls=receiver(f); const head=f.git('rev-parse','HEAD'); const index=f.git('write-tree'); const status=f.git('status','--porcelain');
 const result=f.run('--push','--dry-run'); assert.equal(result.status,0,result.stderr);
 assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('write-tree'),index); assert.equal(f.git('rev-parse','origin/task'),head); assert.equal(f.git('status','--porcelain'),status);
 assert.equal(calls().every(c=>c.channel==='runpane:repos:list'),true); assert.equal(fs.existsSync(path.join(f.root,'home')),false);
});
test('failed sender push prevents note transfer and receiver creation', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty'); const calls=receiver(f);
 f.git('remote','set-url','origin',path.join(f.root,'missing.git'));
 const result=f.run('--push'); assert.notEqual(result.status,0); assert.equal(calls().every(c=>c.channel==='runpane:repos:list'),true); assert.equal(fs.existsSync(path.join(f.root,'home')),false);
});
test('failed destination fetch prevents note transfer and launch', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const calls=receiver(f);
 f.git('remote','set-url','origin',path.join(f.root,'missing.git'));
 // Keep receiver remote identity equal to sender while making fetch unavailable.
 const result=f.run(); assert.notEqual(result.status,0); assert.match(result.stderr,/git fetch failed/);
 assert.equal(calls().some(a=>a.channel==='runpane:panes:create'),false); assert.equal(fs.existsSync(path.join(f.root,'home')),false);
});
test('failed note write prevents agent launch', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const calls=receiver(f); fs.mkdirSync(f.env.HOME,{recursive:true}); fs.writeFileSync(path.join(f.env.HOME,'.pane'),'not a directory');
 const result=f.run(); assert.notEqual(result.status,0); assert.match(result.stderr,/ENOTDIR|not a directory/); assert.equal(calls().some(a=>a.channel==='runpane:repos:list'),true); assert.equal(calls().some(a=>a.channel==='runpane:panes:create'),false);
});
test('partial receiver failure names sent note and created Pane for recovery', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); receiver(f,{item:{ok:false,sessionId:'partial-pane',panelId:'partial-panel',error:{message:'agent readiness failed'}}});
 const result=f.run(); assert.notEqual(result.status,0); assert.match(result.stderr,/agent readiness failed/); assert.match(result.stderr,/partial-pane/); assert.match(result.stderr,/handoffs.*\.md/); assert.match(result.stderr,/agents status/);
});

test('receiver command failure without a create result preserves diagnostics and sent-note recovery', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
 receiver(f,{createError:'receiver unavailable'});
 const result=f.run(); assert.notEqual(result.status,0);
 assert.match(result.stderr,/runpane panes create failed.*receiver unavailable/);
 assert.match(result.stderr,/note was sent.*handoffs.*\.md/);
 assert.match(result.stderr,/sessions list/);
 assert.doesNotMatch(result.stderr,/agents status --pane/);
});

for (const staged of [true, false]) test(`two-dot note ${staged ? 'staged refuses push' : 'unstaged stays out of push'}`, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'..handoff.md'),filled({Goal:'private two-dot marker'}));
 if(staged) f.git('add','..handoff.md');
 fs.writeFileSync(path.join(f.root,'code.txt'),'changed'); receiver(f);
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

test('same-second handoffs preserve both receiving notes', (t) => {
 const f=fixture(t); receiver(f);
 const clock=path.join(f.root,'fixed-clock.cjs');
 fs.writeFileSync(clock,"const RealDate=Date; global.Date=class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-05T12:00:00.000Z'])); } };\n");
 f.git('add','fixed-clock.cjs'); f.git('commit','-m','clock fixture'); f.git('push');
 f.env.NODE_OPTIONS+=` --require=${JSON.stringify(clock)}`;
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

test('Cursor effort fails before Git or receiver side effects', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty'); receiver(f);
 const head=f.git('rev-parse','HEAD'); const index=f.git('write-tree');
 for(const args of [['cursor high here'],['cursor here','--effort','high']]) {
  const result=spawnSync(process.execPath,[cli,'handoff',...args,'--note-file','note.md','--push'],{cwd:f.root,encoding:'utf8',env:f.env});
  assert.notEqual(result.status,0); assert.match(result.stderr,/Cursor.*effort.*not supported/i);
  assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('write-tree'),index); assert.equal(f.git('rev-parse','origin/task'),head);
  assert.equal(fs.existsSync(path.join(f.root,'receiver-args.jsonl')),false); assert.equal(fs.existsSync(f.env.HOME),false);
 }
});

test('OpenCode handoff fails before Git, commands, files, or receiver side effects', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  fs.writeFileSync(path.join(f.root, 'code.txt'), 'dirty');
  receiver(f);
  const head = f.git('rev-parse', 'HEAD'); const index = f.git('write-tree'); const status = f.git('status', '--porcelain');
  const commands = path.join(f.root, '.git', 'handoff-commands.jsonl');
  fs.appendFileSync(path.join(f.root, '.git', 'isolated-tailnet.cjs'), `for(const method of ['spawn','execFileSync']){const original=cp[method];cp[method]=(...args)=>{require('node:fs').appendFileSync(${JSON.stringify(commands)},JSON.stringify(args.slice(0,2))+'\\n');return original(...args);};}\n`);
  const rejection = /OpenCode is supported in terminal panes, but handoff to OpenCode is not supported yet/i;
  const cases = [
    ['opencode here'],
    ['OpenCode model=openai/gpt-5 here'],
    ['opencode gpt-5 high here'],
    ['--agent', 'opencode'],
    ['codex here', '--agent', 'opencode', '--model', 'openai/gpt-5', '--effort', 'high'],
    ...['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].flatMap(effort => [
      [`opencode effort=${effort} here`], ['opencode here', '--effort', effort],
    ]),
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [cli, 'handoff', ...args, '--note-file', 'note.md', '--push'], { cwd: f.root, encoding: 'utf8', env: f.env });
    assert.notEqual(result.status, 0, JSON.stringify(args)); assert.match(result.stderr, rejection);
    assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(f.git('write-tree'), index); assert.equal(f.git('rev-parse', 'origin/task'), head);
    assert.equal(f.git('status', '--porcelain'), status);
    assert.equal(fs.existsSync(commands), false); assert.equal(fs.existsSync(path.join(f.root, 'receiver-args.jsonl')), false); assert.equal(fs.existsSync(f.env.HOME), false);
  }
});

test('repository selector with mismatched remote gives actionable matching-remote guidance', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
 const clone=path.join(f.root,'other-clone'); fs.mkdirSync(clone);
 f.git('init',clone); f.git('-C',clone,'remote','add','origin','https://github.com/example/other.git');
 f.git('config','status.showUntrackedFiles','no'); const calls=receiver(f,{repoPath:clone});
 const result=f.run('--repo','receiver'); assert.notEqual(result.status,0);
 assert.match(result.stderr,/Add a matching Git remote/); assert.doesNotMatch(result.stderr,/or pass --repo/);
 assert.equal(calls().some(a=>a.channel==='runpane:panes:create'),false); assert.equal(fs.existsSync(f.env.HOME),false);
});

test('remote PowerShell carries prompt and tool command as daemon JSON without host CLI', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const calls=windowsHost(f,{remote:true,shell:'powershell.exe'});
 const result=f.run('--machine','windows-host','--model','gpt-5','--effort','high'); assert.equal(result.status,0,result.stderr);
 const create=calls().find(c=>c.channel==='runpane:panes:create'); assert.ok(create,'create request goes directly to the selected daemon');
 const request=create.args[0]; const pane=request.panes[0];
 assert.equal(pane.baseBranch,f.git('rev-parse','HEAD')); assert.equal(request.waitReady,true); assert.equal(request.noFocus,true);
 assert.match(pane.tool.initialInput, /"Receiver instructions"/); assert.match(pane.tool.command,/model_reasoning_effort=high/);
 assert.equal(request.associateSession,undefined);
 assert.equal(calls().some(c=>c.channel==='runpane:machine:exec'&&/runpane|Receiver instructions|--prompt|--tool-command/.test(c.args[0].command)&&!c.args[0].command.startsWith('echo ')),false);
});

test('note through a directory alias stays protected in the canonical Git checkout', (t) => {
 const f=fixture(t); receiver(f); fs.writeFileSync(path.join(f.root,'note.md'),filled()); f.git('add','note.md'); f.git('commit','-m','existing note'); f.git('push');
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

 test('dry-run resolves reachable destination repository and OS before sender mutations', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty');
 const calls=receiver(f); const head=f.git('rev-parse','HEAD'); const index=f.git('write-tree');
 const result=f.run('--dry-run','--push'); assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout); assert.equal(output.repo.name,'receiver'); assert.equal(output.repo.path,f.root); assert.equal(output.repo.environment,'native'); assert.equal(output.destination.os,process.platform==='win32'?'Windows':process.platform==='darwin'?'macOS':'Linux');
 assert.equal(calls().some(c=>c.channel==='runpane:panes:create'),false); assert.equal(fs.existsSync(f.env.HOME),false);
 assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('write-tree'),index);
 });

test('unreachable destination rejects push before changing sender work', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty');
 const head=f.git('rev-parse','HEAD'); const index=f.git('write-tree');
 for(const flags of [['--push'],['--dry-run','--push']]) {
 const result=f.run(...flags); assert.notEqual(result.status,0); assert.match(result.stderr,/Could not connect to Pane daemon/);
 assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('write-tree'),index); assert.equal(f.git('rev-parse','origin/task'),head); assert.equal(fs.existsSync(f.env.HOME),false);
 }
});

function windowsHost(f, options={}) {
 const log=path.join(f.root,'.git','host-transport.jsonl'); const preload=path.join(f.root,'.git','host-transport.cjs');
 const host={name:'windows-host',dnsName:'windows-host.invalid',os:'Windows',online:true,ips:[],self:!options.remote};
 const self=options.remote?{name:'sender',dnsName:'sender.invalid',os:'Linux',online:true,ips:[],self:true}:host;
 const repo={id:7,name:'experiments (win)',path:options.repoPath??'C:/Users/Jane Doe/repo',environment:options.environment??'windows',active:true,sessionCount:0};
 const item={index:0,ok:true,pinned:false,warnings:[],sessionId:'host-pane',panelId:'host-panel',initialInput:{delivered:true,submitted:true,inputBytes:20,verifiedSubmitted:true,delivery:{state:'taken',evidence:'transcript'}},...options.item};
 fs.writeFileSync(preload,`const fs=require('node:fs');const decodeBoundary=require(${JSON.stringify(path.join(dist,'boundaryDecoder.js'))}).decodeBoundary;const decode=(schema,value)=>decodeBoundary(value,schema);require(${JSON.stringify(path.join(dist,'workspace.js'))}).readTailnet=async()=>({ok:true,self:${JSON.stringify(self)},machines:${JSON.stringify(options.remote?[host]:[])}});
 const cp=require('node:child_process');const spawn=cp.spawn;cp.spawn=(command,args,opts)=>command==='runpane'&&args.includes('repos')&&${JSON.stringify(options.hostWrapper??false)}?spawn(process.execPath,['-e',"console.error('Windows wrapper must not override Linux daemon');process.exit(1)"],opts):command==='runpane'?spawn(process.execPath,[${JSON.stringify(cli)},...args],opts):spawn(command,args,opts);
 require(${JSON.stringify(path.join(dist,'daemonClient.js'))}).invokeRemoteDaemon=async(target,channel,args,schema)=>{
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({target,channel,args})+'\\n');
 if(channel==='runpane:panels:screen')return decode(schema,{ok:true,panelId:args[0].panelId,paneId:'host-pane',source:'scrollback',limit:100,returnedLineCount:1,hasMore:false,text:'receiver screen proof',state:{initialized:true},composer:{isPresent:true,hasUndeliveredText:false}});
 if(channel==='runpane:repos:list')return decode(schema,{ok:true,repos:[${JSON.stringify(repo)}]});
 if(channel==='runpane:panes:create')return decode(schema,{ok:${JSON.stringify(item.ok)},repo:${JSON.stringify(repo)},items:[${JSON.stringify(item)}]});
 if(channel==='runpane:machine:write')return decode(schema,{path:'C:/Users/Jane Doe/handoffs/'+args[0].path.split('/').pop(),bytes:args[0].content.length});
 const command=args[0].command;let stdout='';
 if(/^(runpane|npx)(?: |$)/.test(command))return decode(schema,{os:'Windows',shell:${JSON.stringify(options.shell??'bash.exe')},exitCode:127,stdout:'',stderr:'runpane: command not found'});
 if(command.includes('remote -v'))stdout='origin '+${JSON.stringify(f.git('remote','get-url','origin'))}+' (fetch)';
 return decode(schema,{os:'Windows',shell:${JSON.stringify(options.shell??'bash.exe')},exitCode:0,stdout,stderr:''});};
 global.fetch=async(url,options)=>{const request=JSON.parse(options.body);const result=await require(${JSON.stringify(path.join(dist,'daemonClient.js'))}).invokeRemoteDaemon({machine:'windows-host',baseUrl:url},request.channel,request.args,require(${JSON.stringify(path.join(dist,'boundaryDecoder.js'))}).boundary.json);return {status:200,text:async()=>JSON.stringify({ok:true,result})};};`);
 f.env.NODE_OPTIONS=`--require=${JSON.stringify(preload)}`; f.env.WSL_DISTRO_NAME='HermeticWSL'; delete f.env.PANE_DIR;
 return ()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[];
}
test('WSL handoff reaches its native Windows host without a Linux daemon', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const calls=windowsHost(f);
 const result=f.run('--repo','experiments (win)'); assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout); assert.equal(output.destination.os,'Windows'); assert.equal(output.repo.name,'experiments (win)'); assert.equal(output.pane.panelId,'host-panel');
 const note=calls().find(c=>c.channel==='runpane:machine:write'&&!c.args[0].path.endsWith('.json')); assert.match(note.args[0].content,/Receiver instructions/);
 const create=calls().find(c=>c.channel==='runpane:panes:create'); assert.match(create.args[0].panes[0].tool.initialInput,/Receiver instructions/);
 assert.equal(fs.existsSync(f.env.HOME),false);
});
test('saved WSL repository fails clearly before sender push or destination mutations', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty');
 const head=f.git('rev-parse','HEAD'); const index=f.git('write-tree'); const calls=windowsHost(f,{environment:'wsl',repoPath:'//wsl.localhost/Ubuntu/repos/project'});
 const result=f.run('--repo','experiments (win)','--push'); assert.notEqual(result.status,0); assert.match(result.stderr,/WSL.*native Windows.*Nothing was committed or sent/i);
 assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('write-tree'),index); assert.equal(f.git('rev-parse','origin/task'),head);
 assert.equal(calls().some(c=>c.channel==='runpane:machine:write'||/fetch|panes create/.test(c.args[0]?.command??'')||c.channel==='runpane:panes:create'),false);
});
test('WSL keeps a reachable Linux daemon ahead of its Windows host', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const local=receiver(f,{paneDir:path.join(f.env.HOME,'.pane')}); const host=windowsHost(f,{hostWrapper:true});
 const result=f.run('--dry-run'); assert.equal(result.status,0,result.stderr);
 assert.equal(JSON.parse(result.stdout).repo.path,f.root); assert.equal(local().some(c=>c.channel==='runpane:repos:list'),true); assert.deepEqual(host(),[]);
});
test('WSL explicit instance selection never silently falls back to another host instance', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const host=windowsHost(f);
 const result=f.run('--dry-run','--pane-dir',path.join(f.root,'selected-instance'));
 assert.notEqual(result.status,0); assert.match(result.stderr,/Could not connect to Pane daemon/); assert.deepEqual(host(),[]);
});
test('WSL dry-run validates the Windows host read-only', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); fs.writeFileSync(path.join(f.root,'code.txt'),'dirty'); const host=windowsHost(f); const head=f.git('rev-parse','HEAD');
 const result=f.run('--dry-run','--push','--repo','experiments (win)'); assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).destination.os,'Windows');
 assert.equal(host().some(c=>c.channel==='runpane:machine:write'||/fetch|panes create/.test(c.args[0]?.command??'')||c.channel==='runpane:panes:create'),false); assert.equal(f.git('rev-parse','HEAD'),head);
});

test('blocked receiver prompt exits nonzero and retains pane, panel, note and inspection guidance', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); receiver(f,{item:{ok:true,sessionId:'blocked-pane',panelId:'blocked-panel',initialInput:{delivered:true,submitted:true,inputBytes:20,verifiedSubmitted:false,delivery:{state:'in-composer',evidence:'screen'},blocked:{kind:'agent-prompt',message:'Cannot use the background server'}}}});
 const result=f.run(); assert.notEqual(result.status,0); const output=JSON.parse(result.stdout); assert.equal(output.ok,false); assert.equal(output.pane.id,'blocked-pane'); assert.equal(output.pane.panelId,'blocked-panel'); assert.match(output.notePath,/handoffs/); assert.match(output.warnings.join(' '),/Cannot use the background server.*panels screen --panel blocked-panel/);
});
for (const [label,input,success] of [
 ['taken',{verifiedSubmitted:true,delivery:{state:'taken',evidence:'transcript'}},true],
 ['queued',{verifiedSubmitted:true,delivery:{state:'queued',evidence:'screen'}},true],
 ['unknown',{verifiedSubmitted:false,delivery:{state:'unknown',evidence:'screen'}},false],
 ['missing',undefined,false],
 ['contradictory',{verifiedSubmitted:true,delivery:{state:'in-composer',evidence:'screen'}},false],
 ['verification missing',{delivery:{state:'taken',evidence:'transcript'}},false],
]) test(`receiver delivery ${label} ${success?'succeeds':'fails with recovery identity'}`, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const item={ok:true,sessionId:'delivery-pane',panelId:'delivery-panel'}; if(input) item.initialInput={delivered:true,submitted:true,inputBytes:20,...input}; receiver(f,{item});
 const result=f.run(); assert.equal(result.status,success?0:1,result.stderr); const output=JSON.parse(result.stdout); assert.equal(output.ok,success); assert.equal(output.pane.panelId,'delivery-panel');
 if(!success) assert.match(output.warnings.join(' '),/panels screen --panel delivery-panel/);
});
test('partial creation failure retains panel inspection guidance', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); receiver(f,{item:{ok:false,sessionId:'partial-pane',panelId:'partial-panel',error:{message:'startup dialog blocked'}}});
 const result=f.run(); assert.notEqual(result.status,0); assert.match(result.stderr,/partial-pane/); assert.match(result.stderr,/panels screen --panel partial-panel/);
});

test('dry-run does not need or install a destination CLI', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const host=windowsHost(f,{cliMissing:true});
 const result=f.run('--dry-run'); assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).destination.os,'Windows'); assert.equal(host().some(c=>c.args[0]?.command?.includes('npx')),false);
});

test('WSL dry-run uses reachable bundled Windows daemon with Git Bash and no global CLI', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const host=windowsHost(f);
 const result=f.run('--dry-run','--repo','experiments (win)'); assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout); assert.equal(output.repo.name,'experiments (win)'); assert.equal(output.repo.environment,'windows'); assert.equal(output.destination.os,'Windows');
 assert.equal(host().some(c=>c.channel==='runpane:repos:list'),true);
 assert.equal(host().some(c=>c.channel==='runpane:machine:write'||c.channel==='runpane:panes:create'||/^(runpane|npx)(?: |$)| fetch /.test(c.args[0]?.command??'')),false);
});

test('WSL falls back from a stale Linux socket to its reachable Windows host', {skip:process.platform!=='linux'}, async (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const paneDir=path.join(f.env.HOME,'.pane'); const local=receiver(f,{paneDir}); const host=windowsHost(f);
 const endpoint=require(path.join(dist,'daemonClient.js')).getPaneDaemonEndpoint(paneDir); t.after(()=>fs.rmSync(path.dirname(endpoint.path),{recursive:true,force:true}));
 await local.stop(); assert.equal(fs.existsSync(endpoint.path),true);
 const result=f.run('--dry-run','--repo','experiments (win)'); assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).destination.os,'Windows'); assert.equal(host().some(c=>c.channel==='runpane:repos:list'),true);
});
test('unverified local receiver inspection preserves explicit Pane directory', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const selected=path.join(f.root,'selected pane'); receiver(f,{paneDir:selected,item:{ok:true,sessionId:'selected-pane',panelId:'selected-panel'}});
 const result=f.run('--pane-dir',selected); assert.equal(result.status,1,result.stderr); const output=JSON.parse(result.stdout);
 assert.match(output.warnings.join(' '),new RegExp(`runpane --pane-dir ['"]${selected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}['"] panels screen --panel selected-panel`));
});
test('partial Windows receiver recovery routes directly from the sender without host CLI', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); windowsHost(f,{item:{ok:false,pinned:undefined,warnings:undefined,initialInput:undefined,error:{message:'startup dialog blocked'}}});
 const result=f.run(); assert.notEqual(result.status,0); assert.match(result.stderr,/runpane workspace windows-host panels screen --panel host-panel/); assert.match(result.stderr,/Pane host-pane/); assert.doesNotMatch(result.stderr,/exec -- runpane/);
});
test('successful local receiver status preserves explicit Pane directory', (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); const selected=path.join(f.root,'selected pane'); receiver(f,{paneDir:selected});
 const result=spawnSync(process.execPath,[cli,'handoff','codex here','--note-file','note.md','--pane-dir',selected],{cwd:f.root,encoding:'utf8',env:f.env});
 assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/Check on it: runpane --pane-dir/); assert.equal(result.stdout.split('Check on it:')[1].includes(selected),true); assert.match(result.stdout,/agents status --panel test-panel/);
});
test('successful Windows receiver status routes directly from the sender', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); windowsHost(f);
 const result=spawnSync(process.execPath,[cli,'handoff','codex here','--note-file','note.md'],{cwd:f.root,encoding:'utf8',env:f.env});
 assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/Check on it: runpane workspace windows-host panels screen --panel host-panel/); assert.doesNotMatch(result.stdout,/exec -- runpane/);
});
test('unverified Windows receiver inspection routes directly and retains note identity', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); windowsHost(f,{item:{initialInput:{delivered:true,submitted:false,inputBytes:20,verifiedSubmitted:false,delivery:{state:'in-composer',evidence:'screen'}}}});
 const result=f.run(); assert.equal(result.status,1,result.stderr); const output=JSON.parse(result.stdout); assert.equal(output.pane.panelId,'host-panel'); assert.match(output.notePath,/C:\/Users\/Jane Doe\/handoffs/); assert.match(output.warnings.join(' '),/runpane workspace windows-host panels screen --panel host-panel/); assert.doesNotMatch(output.warnings.join(' '),/exec -- runpane/);
});

test('WSL keeps a responding Linux daemon when repo discovery reports an application ENOENT', {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled()); receiver(f,{paneDir:path.join(f.env.HOME,'.pane'),reposError:{message:'saved repository data missing',code:'ENOENT'}}); const host=windowsHost(f);
 const result=f.run('--dry-run'); assert.notEqual(result.status,0); assert.match(result.stderr,/saved repository data missing/); assert.deepEqual(host(),[]);
});

for (const partial of [false,true]) test(`generated remote ${partial?'partial-failure':'success'} guidance executes through actual CLI routing`, {skip:process.platform!=='linux'}, (t) => {
 const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
 const options=partial?{item:{ok:false,pinned:undefined,warnings:undefined,initialInput:undefined,error:{message:'startup dialog blocked'}}}:{};
 const calls=windowsHost(f,options);
 const handoff=spawnSync(process.execPath,[cli,'handoff','codex here','--note-file','note.md'],{cwd:f.root,encoding:'utf8',env:f.env});
 assert.equal(handoff.status,partial?1:0,handoff.stderr);
 const command=(partial?handoff.stderr.match(/Check (runpane .*?) before retrying/):handoff.stdout.match(/Check on it: (runpane .*)/))?.[1];
 assert.ok(command,'handoff prints an actionable receiver command');
 const inspected=spawnSync(process.execPath,[cli,...command.split(' ').slice(1)],{cwd:f.root,encoding:'utf8',env:f.env});
 assert.equal(inspected.status,0,inspected.stderr); assert.match(inspected.stdout,/receiver screen proof/);
 const screen=calls().find(c=>c.channel==='runpane:panels:screen'); assert.equal(screen.target.machine,'windows-host'); assert.equal(screen.args[0].panelId,'host-panel');
});
