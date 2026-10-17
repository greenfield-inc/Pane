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
    createError: options.createError, reposError: options.reposError, ownedPane: options.ownedPane,
    sender: options.sender, screenText: options.screenText, receiverResumeId: options.receiverResumeId, item: options.item ?? { ok: true, sessionId: 'test-pane', panelId: 'test-panel', initialInput:{delivered:true,submitted:true,inputBytes:20,verifiedSubmitted:true,delivery:{state:'taken',evidence:'transcript'}} } }));
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

test('a fresh OpenCode agent with only a note is refused before Git, commands, files, or receiver side effects', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  fs.writeFileSync(path.join(f.root, 'code.txt'), 'dirty');
  receiver(f);
  const head = f.git('rev-parse', 'HEAD'); const index = f.git('write-tree'); const status = f.git('status', '--porcelain');
  const commands = path.join(f.root, '.git', 'handoff-commands.jsonl');
  fs.appendFileSync(path.join(f.root, '.git', 'isolated-tailnet.cjs'), `for(const method of ['spawn','execFileSync']){const original=cp[method];cp[method]=(...args)=>{require('node:fs').appendFileSync(${JSON.stringify(commands)},JSON.stringify(args.slice(0,2))+'\\n');return original(...args);};}\n`);
  const rejection = /OpenCode (receives a handoff only to continue your own OpenCode session|effort is not supported)/i;
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

// A Session sender: a Session's folder sits outside git, and its terminal sets
// PANE_ORCHESTRATION_SESSION_ID. Tailnet and both daemons are external boundaries.
function sessionSender(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'session'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'note.md'), filled());
  const log = path.join(root, 'calls.jsonl'); const preload = path.join(root, 'boundaries.cjs');
  const machineOf = (name, self = false) => ({ name, dnsName: `${name}.tail.invalid`, os: 'macOS', online: true, ips: [], self, owner: 'tyler@github', mine: true });
  const record = (fields) => ({ id: 'source-session', name: 'Pane Fixes', agent: 'claude', internalSessionId: 'internal', panelIds: { claude: 'p1', codex: 'p2', cursor: 'p3' },
    goal: 'Ship the fixes', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [], activity: [], revision: 1,
    createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', ...fields });
  const source = record(options.source ?? {});
  const existing = (options.existing ?? []).map((name, index) => record({ id: `existing-${index}`, name }));
  fs.writeFileSync(preload, `const fs=require('node:fs');const {decodeBoundary}=require(${JSON.stringify(path.join(dist, 'boundaryDecoder.js'))});
const log=(entry)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(entry)+'\\n');
require(${JSON.stringify(path.join(dist, 'workspace.js'))}).readTailnet=async()=>({ok:true,self:${JSON.stringify(machineOf('tylers-macbook', true))},machines:[${JSON.stringify(machineOf('tylers-mac-mini'))}]});
const client=require(${JSON.stringify(path.join(dist, 'daemonClient.js'))});
client.invokeDaemon=async(channel,args,schema)=>{log({local:true,channel,args});
 if(channel==='runpane:sessions:get'&&args[0].sessionId===${JSON.stringify(source.id)})return decodeBoundary({ok:true,session:${JSON.stringify(source)}},schema);
 throw new Error('Unexpected local channel '+channel);};
client.invokeRemoteDaemon=async(target,channel,args,schema)=>{log({target:target.machine,channel,args});
 if(channel==='runpane:machine:exec')return decodeBoundary({os:'macOS',shell:'/bin/zsh',exitCode:0,stdout:'runpane-handoff\\n',stderr:''},schema);
 if(channel==='runpane:machine:write')return decodeBoundary({path:'/Users/tyler/.pane/handoffs/'+args[0].path.split('/').pop(),bytes:args[0].content.length},schema);
 if(channel==='runpane:sessions:list')return decodeBoundary({ok:true,sessions:${JSON.stringify(existing)}},schema);
 if(channel==='runpane:sessions:create')return decodeBoundary({ok:true,session:{...${JSON.stringify(record({ id: 'received-session' }))},...args[0]},panelId:'received-panel'},schema);
 throw new Error('Unexpected remote channel '+channel);};
`);
  const env = { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1', HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), PANE_DIR: path.join(root, 'isolated-data'),
    GIT_CEILING_DIRECTORIES: root, PANE_ORCHESTRATION_SESSION_ID: source.id, PANE_SESSION_ID: 'internal', PANE_PANEL_ID: 'source-panel', NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
  delete env.FOOZOL_DIR;
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const run = (destination, ...args) => spawnSync(process.execPath, [cli, 'handoff', destination, '--note-file', 'note.md', '--json', ...args], { cwd: folder, encoding: 'utf8', env });
  return { root, folder, env, calls, run };
}

test('a handoff from a Session folder creates a Session on the target with the same name, goal and agent, and no git', (t) => {
  const s = sessionSender(t);
  const result = s.run('claude on tylers-mac-mini');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /git/i);
  const remote = s.calls().filter(c => c.target === 'tylers-mac-mini');
  const write = remote.find(c => c.channel === 'runpane:machine:write');
  assert.match(write.args[0].path, /^~\/\.pane\/handoffs\/.*\.md$/);
  assert.match(write.args[0].content, /^origin_session: source-session$/m);
  assert.match(write.args[0].content, /## Receiver instructions/);
  const create = remote.find(c => c.channel === 'runpane:sessions:create').args[0];
  assert.equal(create.name, 'Pane Fixes'); assert.equal(create.goal, 'Ship the fixes'); assert.equal(create.agent, 'claude');
  const output = JSON.parse(result.stdout);
  assert.match(create.nextAction, /^Read the handoff note at \/Users\/tyler\/\.pane\/handoffs\/.*\.md and continue from it\.$/);
  assert.match(create.context, new RegExp(output.notePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.match(create.context, /tylers-macbook/);
  assert.equal(output.receiver.route, 'session');
  assert.deepEqual(output.session, { id: 'received-session', name: 'Pane Fixes', machine: 'tylers-mac-mini' });
  assert.equal(output.git, undefined);
  assert.equal(remote.some(c => c.channel === 'runpane:panes:create' || c.channel === 'runpane:repos:list'), false);
});

test('a Session handoff numbers the name when the target already has a Session called that', (t) => {
  const s = sessionSender(t, { existing: ['Pane Fixes', 'pane fixes 2'] });
  const result = s.run('claude on tylers-mac-mini');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.calls().find(c => c.channel === 'runpane:sessions:create').args[0].name, 'Pane Fixes 3');
  assert.equal(JSON.parse(result.stdout).session.name, 'Pane Fixes 3');
});

test('a Session handoff to this machine is refused before anything is sent', (t) => {
  const s = sessionSender(t);
  const result = s.run('claude here');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another machine/);
  assert.match(result.stderr, /Nothing was sent/);
  assert.deepEqual(s.calls().filter(c => !c.local), []);
});

test('a Session handoff dry run creates nothing and reports the Session route', (t) => {
  const s = sessionSender(t, { existing: ['Pane Fixes'] });
  const result = s.run('codex on tylers-mac-mini', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true); assert.equal(output.receiver.route, 'session');
  assert.deepEqual(output.session, { name: 'Pane Fixes 2', machine: 'tylers-mac-mini' });
  assert.equal(s.calls().some(c => c.channel === 'runpane:sessions:create' || c.channel === 'runpane:machine:write'), false);
});

test('a git checkout keeps the Pane route even inside a Session terminal', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  receiver(f); f.env.PANE_ORCHESTRATION_SESSION_ID = 'source-session';
  const result = f.run('--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.notEqual(output.receiver?.route, 'session'); assert.equal(output.git.branch, 'task');
});

// ---------------------------------------------------------------- carrying the sender's own session

const SENDER = '6f1d2c3b-4a59-4e7d-8c21-90ab12cd34ef';
const LAST = 'Renamed the login handler and the tests are green';

/** A Claude store in the fixture's home with one session, and a stand-in `claude` that forks it. */
function claudeSession(f) {
  const store = path.join(f.env.HOME, '.claude', 'projects', 'C--work-app');
  fs.mkdirSync(store, { recursive: true });
  const transcript = path.join(store, `${SENDER}.jsonl`);
  fs.writeFileSync(transcript, [
    { type: 'user', sessionId: SENDER, message: { role: 'user', content: 'the codeword is heron' } },
    { type: 'assistant', sessionId: SENDER, message: { role: 'assistant', content: [{ type: 'text', text: `Done.\n${LAST} now.` }] } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  f.env.CLAUDE_CONFIG_DIR = path.join(f.env.HOME, '.claude');
  const bin = path.join(f.root, 'fake-bin');
  const calls = path.join(bin, 'claude-calls.jsonl');
  fs.writeFileSync(path.join(bin, 'claude.js'), [
    "const fs = require('node:fs'); const path = require('node:path');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');`,
    "const from = args[args.indexOf('--resume') + 1]; const to = args[args.indexOf('--session-id') + 1];",
    `const dir = ${JSON.stringify(store)};`,
    "const lines = fs.readFileSync(path.join(dir, from + '.jsonl'), 'utf8').split(from).join(to);",
    "fs.writeFileSync(path.join(dir, to + '.jsonl'), lines + JSON.stringify({ type: 'assistant', sessionId: to, message: { role: 'assistant', content: 'forked' } }) + '\\n');",
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0claude.js" %*\r\n`);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath.split(path.sep).join('/')}" "$(dirname "$0")/claude.js" "$@"\n`, { mode: 0o755 });
  const inherited = f.env.PATH ?? f.env.Path ?? '';
  delete f.env.Path;
  f.env.PATH = `${bin}${path.delimiter}${inherited}`;
  f.env.PANE_SESSION_ID = 'sender-pane';
  f.env.PANE_PANEL_ID = 'sender-panel';
  return { transcript, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []) };
}
const runClaude = (f, ...args) => spawnSync(process.execPath, [cli, 'handoff', 'claude here', '--note-file', 'note.md', '--json', ...args], { cwd: f.root, encoding: 'utf8', env: f.env });

test('a same-machine handoff to the same agent resumes a fork of the sender\'s session and checks it', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  const calls = receiver(f, { sender: { agentType: 'claude', resumeId: SENDER, resumeSource: 'agent' }, screenText: `> the codeword is heron\n● Done.\n  ${LAST} now.\n● forked` });
  const claude = claudeSession(f);
  const before = fs.readFileSync(claude.transcript);
  const result = runClaude(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const out = JSON.parse(result.stdout);
  const fork = claude.calls()[0];
  assert.deepEqual(fork.slice(0, 5), ['-p', '--resume', SENDER, '--fork-session', '--session-id']);
  assert.equal(out.continuity.result, 'continued');
  assert.equal(out.continuity.fork, true);
  assert.equal(out.continuity.resumedId, fork[5]);
  assert.deepEqual(out.continuity.checks, { resumedById: true, restartResumes: true, historyLoaded: true, originalUntouched: true });
  const tab = calls().find(c => c.channel === 'runpane:panels:create').args[0];
  assert.equal(tab.resume, fork[5]);
  assert.equal(tab.tool.initialInput, undefined);
  assert.deepEqual(fs.readFileSync(claude.transcript), before);
  // Same Pane, same folder: no "moved" message.
  assert.equal(calls().some(c => c.channel === 'runpane:panels:submit'), false);
});

test('a dry run says which session would be carried, and forks nothing', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  receiver(f, { sender: { agentType: 'claude', resumeId: SENDER, resumeSource: 'agent' } });
  const claude = claudeSession(f);
  const result = runClaude(f, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.continuity.carried, true);
  assert.equal(out.continuity.sessionId, SENDER);
  assert.equal(out.continuity.fork, true);
  assert.equal(out.continuity.files, 1);
  assert.equal(out.continuity.result, undefined);
  assert.deepEqual(claude.calls(), []);
});

for (const [name, sender, destination, reason] of [
  ['a different agent', { agentType: 'claude', resumeId: SENDER }, 'codex here', /session is claude and the receiver is codex/],
  ['a shell tab with no agent session', {}, 'claude here', /runs no Claude, Codex, Cursor or OpenCode session/],
]) test(`a handoff from ${name} starts a fresh agent with the note and says so`, (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  const calls = receiver(f, { sender });
  claudeSession(f);
  const result = spawnSync(process.execPath, [cli, 'handoff', destination, '--note-file', 'note.md', '--json'], { cwd: f.root, encoding: 'utf8', env: f.env });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.continuity.carried, false);
  assert.equal(out.continuity.result, 'fresh-agent');
  assert.match(out.continuity.reason, reason);
  const tab = calls().find(c => c.channel === 'runpane:panels:create').args[0];
  assert.equal(tab.resume, undefined);
  assert.match(tab.tool.initialInput, /^Read the handoff note at/);
  const human = spawnSync(process.execPath, [cli, 'handoff', destination, '--note-file', 'note.md', '--dry-run'], { cwd: f.root, encoding: 'utf8', env: f.env });
  assert.match(human.stdout, /fresh (codex|claude) with your note, not the same session/);
});

test('a receiver whose check fails is kept, exits non-zero, and names the note route', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  receiver(f, { sender: { agentType: 'claude', resumeId: SENDER, resumeSource: 'agent' }, receiverResumeId: 'some-other-session' });
  claudeSession(f);
  const result = runClaude(f);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.continuity.result, 'not-continued');
  assert.equal(out.continuity.checks.restartResumes, false);
  assert.match(out.continuity.next, /--note-only/);
  assert.equal(out.pane.panelId, 'test-tab');
});

test('--note-only starts a fresh agent even when the session could be carried', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  const calls = receiver(f, { sender: { agentType: 'claude', resumeId: SENDER, resumeSource: 'agent' } });
  const claude = claudeSession(f);
  const result = runClaude(f, '--note-only');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).continuity.result, 'fresh-agent');
  assert.deepEqual(claude.calls(), []);
  assert.equal(calls().find(c => c.channel === 'runpane:panels:create').args[0].resume, undefined);
});

// ---------------------------------------------------------------- carrying a session to another machine

/**
 * A stand-in for Pane on another machine (test-remote), reached over HTTP like a real workspace,
 * with its own home folder and a clone of the fixture's remote. The CLI's tailnet lookup is
 * pointed at it.
 */
function remoteMachine(f, options = {}) {
  const { spawn } = require('node:child_process');
  const home = path.join(f.root, 'remote-home');
  const repoPath = path.join(home, 'repo');
  fs.mkdirSync(home, { recursive: true });
  execFileSync('git', ['clone', '-q', path.join(f.root, 'remote.git'), repoPath], { env: f.env });
  const log = path.join(f.root, 'remote-calls.jsonl');
  const ready = path.join(f.root, 'remote-ready.json');
  const config = path.join(f.root, 'remote.json');
  fs.writeFileSync(config, JSON.stringify({ home, repoPath, log, ready, agent: options.agent ?? 'claude', screenText: options.screenText }));
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'runpane-handoff-remote.cjs'), config], { env: f.env, stdio: 'ignore' });
  f.t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const { port } = JSON.parse(fs.readFileSync(ready, 'utf8'));
  fs.appendFileSync(path.join(f.root, '.git', 'info', 'exclude'), 'remote-home/\nremote-calls.jsonl\nremote-ready.json\nremote.json\n');
  const self = { name: 'workstation', dnsName: 'workstation.tail.invalid', os: process.platform === 'win32' ? 'Windows' : 'Linux', online: true, ips: [], self: true, owner: 'test@github', mine: true };
  const remote = { ...self, name: 'test-remote', dnsName: 'test-remote.tail.invalid', os: process.platform === 'win32' ? 'Windows' : 'Linux', self: false };
  fs.appendFileSync(path.join(f.root, '.git', 'isolated-tailnet.cjs'), [
    `const workspace = require(${JSON.stringify(path.join(dist, 'workspace.js'))});`,
    `workspace.readTailnet = async () => ({ ok: true, self: ${JSON.stringify(self)}, machines: [${JSON.stringify(remote)}] });`,
    `workspace.workspaceTarget = (machine) => ({ machine: machine.name, baseUrl: 'http://127.0.0.1:${port}' });`,
    '',
  ].join('\n'));
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { home, calls };
}
const runToRemote = (f, ...args) => spawnSync(process.execPath, [cli, 'handoff', 'claude on test-remote', '--note-file', 'note.md', '--json', ...args], { cwd: f.root, encoding: 'utf8', env: f.env });

test('a handoff to another machine copies the sender\'s session into its store and resumes the same id there', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  receiver(f, { sender: { agentType: 'claude', resumeId: SENDER, resumeSource: 'agent' } });
  const claude = claudeSession(f);
  const remote = remoteMachine(f, { screenText: `● Done.\n  ${LAST} now.` });
  const result = runToRemote(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.continuity.result, 'continued');
  assert.equal(out.continuity.fork, false);
  assert.equal(out.continuity.resumedId, SENDER);
  const copy = path.join(remote.home, '.claude', 'projects', 'C--work-app', `${SENDER}.jsonl`);
  assert.deepEqual(fs.readFileSync(copy), fs.readFileSync(claude.transcript));
  assert.deepEqual(claude.calls(), [], 'nothing is forked when the session moves to another machine');
  const create = remote.calls().find(c => c.channel === 'runpane:panes:create').args[0].panes[0];
  assert.equal(create.resume, SENDER);
  assert.equal(create.tool.initialInput, undefined);
  const moved = remote.calls().find(c => c.channel === 'runpane:panels:submit').args[0];
  assert.match(moved.input, /^This session moved to .* on test-remote\. Continue from where you were\. The sender's handoff note is at /);
});

test('a session already in the other machine\'s store is replaced in place, never copied twice', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  receiver(f, { sender: { agentType: 'claude', resumeId: SENDER, resumeSource: 'agent' } });
  const claude = claudeSession(f);
  const remote = remoteMachine(f, { screenText: `${LAST} now.` });
  const earlier = path.join(remote.home, '.claude', 'projects', 'C--Users-me-old-checkout', `${SENDER}.jsonl`);
  fs.mkdirSync(path.dirname(earlier), { recursive: true });
  fs.writeFileSync(earlier, 'an older copy from an earlier handoff\n');
  const result = runToRemote(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(fs.readFileSync(earlier), fs.readFileSync(claude.transcript));
  assert.equal(fs.existsSync(path.join(remote.home, '.claude', 'projects', 'C--work-app', `${SENDER}.jsonl`)), false);
});

test('a session larger than one machine write is sent in parts and joined unchanged', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  receiver(f, { sender: { agentType: 'claude', resumeId: SENDER, resumeSource: 'agent' } });
  const claude = claudeSession(f);
  // 9 MB of earlier conversation before the last message, so the file needs two writes.
  const filler = JSON.stringify({ type: 'user', sessionId: SENDER, message: { role: 'user', content: 'x'.repeat(1024) } }) + '\n';
  const original = fs.readFileSync(claude.transcript, 'utf8');
  fs.writeFileSync(claude.transcript, filler.repeat(9 * 1024) + original);
  const remote = remoteMachine(f, { screenText: `${LAST} now.` });
  const result = runToRemote(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const copyDir = path.join(remote.home, '.claude', 'projects', 'C--work-app');
  assert.deepEqual(fs.readFileSync(path.join(copyDir, `${SENDER}.jsonl`)), fs.readFileSync(claude.transcript));
  assert.deepEqual(fs.readdirSync(copyDir), [`${SENDER}.jsonl`], 'the parts are removed once joined');
  const writes = remote.calls().filter(c => c.channel === 'runpane:machine:write' && c.args[0].path.includes(SENDER));
  assert.equal(writes.length, 2);
});

// ---------------------------------------------------------------- OpenCode

const OPENCODE_SENDER = 'ses_SenderSession123';
const OPENCODE_FORK = 'ses_ForkedSession456';

/** A stand-in `opencode` with one session, which exports it, forks it with a turn, and imports exports. */
function openCodeSession(f) {
  const bin = path.join(f.root, 'fake-bin');
  const calls = path.join(bin, 'opencode-calls.jsonl');
  const exported = JSON.stringify({ info: { id: OPENCODE_SENDER, title: 'login fix' }, messages: [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'the codeword is heron' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: `${LAST} now.` }] },
  ] });
  fs.writeFileSync(path.join(bin, 'opencode.js'), [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');`,
    `if (args[0] === 'export') { if (args[1] !== ${JSON.stringify(OPENCODE_SENDER)}) process.exit(1); process.stderr.write('Exporting session...\\n'); process.stdout.write(${JSON.stringify(exported)}); }`,
    `else if (args[0] === 'run') { console.log(JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: ${JSON.stringify(OPENCODE_FORK)} })); }`,
    "else if (args[0] === 'import') { console.log('Imported session: ' + JSON.parse(fs.readFileSync(args[1], 'utf8')).info.id); }",
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'opencode.cmd'), `@"${process.execPath}" "%~dp0opencode.js" %*\r\n`);
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\nexec "${process.execPath.split(path.sep).join('/')}" "$(dirname "$0")/opencode.js" "$@"\n`, { mode: 0o755 });
  const inherited = f.env.PATH ?? f.env.Path ?? '';
  delete f.env.Path;
  if (!inherited.startsWith(bin)) f.env.PATH = `${bin}${path.delimiter}${inherited}`;
  f.env.PANE_SESSION_ID = 'sender-pane';
  f.env.PANE_PANEL_ID = 'sender-panel';
  return { exported, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []) };
}

test('a same-machine handoff to OpenCode resumes a fork of the sender\'s OpenCode session', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  const calls = receiver(f, { sender: { agentType: 'opencode', resumeId: OPENCODE_SENDER, resumeSource: 'agent' }, screenText: `${LAST} now.` });
  const opencode = openCodeSession(f);
  const result = spawnSync(process.execPath, [cli, 'handoff', 'opencode here', '--note-file', 'note.md', '--json'], { cwd: f.root, encoding: 'utf8', env: f.env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.continuity.result, 'continued');
  assert.equal(out.continuity.resumedId, OPENCODE_FORK);
  assert.equal(out.continuity.checks.originalUntouched, true);
  const fork = opencode.calls().find(c => c.args[0] === 'run').args;
  assert.deepEqual(fork.slice(0, 6), ['run', '--session', OPENCODE_SENDER, '--fork', '--format', 'json']);
  const tab = calls().find(c => c.channel === 'runpane:panels:create').args[0];
  assert.equal(tab.resume, OPENCODE_FORK);
  assert.equal(tab.tool.agent, 'opencode');
});

test('a handoff to OpenCode on another machine imports the sender\'s session there and resumes the same id', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'note.md'), filled());
  receiver(f, { sender: { agentType: 'opencode', resumeId: OPENCODE_SENDER, resumeSource: 'agent' } });
  const opencode = openCodeSession(f);
  const remote = remoteMachine(f, { agent: 'opencode', screenText: `${LAST} now.` });
  const result = spawnSync(process.execPath, [cli, 'handoff', 'opencode on test-remote', '--note-file', 'note.md', '--json'], { cwd: f.root, encoding: 'utf8', env: f.env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.continuity.result, 'continued');
  assert.equal(out.continuity.resumedId, OPENCODE_SENDER);
  const exportFile = path.join(remote.home, '.pane', 'handoffs', `opencode-${OPENCODE_SENDER}.json`);
  assert.equal(fs.readFileSync(exportFile, 'utf8'), opencode.exported);
  const imported = opencode.calls().find(c => c.args[0] === 'import');
  assert.equal(path.resolve(imported.args[1]), path.resolve(exportFile));
  assert.equal(fs.realpathSync(imported.cwd), fs.realpathSync(path.join(remote.home, 'repo')), 'imported from inside the receiving repository');
  const create = remote.calls().find(c => c.channel === 'runpane:panes:create').args[0].panes[0];
  assert.equal(create.resume, OPENCODE_SENDER);
  assert.equal(create.tool.agent, 'opencode');
});
