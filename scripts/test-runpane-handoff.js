// runpane handoff: destination parsing and note validation, through the built package.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const dist = path.join(__dirname, '..', 'packages', 'runpane', 'dist');
const cli = path.join(dist, 'cli.js');
const { parseDestination, validateNote, noteTemplate, HANDOFF_SECTIONS } = require(path.join(dist, 'handoff.js'));

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
else if(args.includes('list')) console.log(JSON.stringify({repos:[{id:7,name:'receiver',path:${JSON.stringify(f.root)}}]}));
else console.log(JSON.stringify({items:[{ok:true,sessionId:'test-pane',panelId:'test-panel'}]}));
`, { mode: 0o700 });
  f.env.PATH = `${bin}${path.delimiter}${f.env.PATH}`;
  f.env.HOME = path.join(f.root, 'home');
  fs.appendFileSync(path.join(f.root, '.git', 'info', 'exclude'), 'fake-bin/\nreceiver-args.jsonl\nhome/\n');
  return () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
}
test('receiver starts at immutable sender commit and uses selected local Pane directory', (t) => {
  const f=fixture(t); fs.writeFileSync(path.join(f.root,'note.md'),filled());
  const head=f.git('rev-parse','HEAD');
  fs.writeFileSync(path.join(f.root,'code.txt'),'remote advances'); f.git('add','code.txt'); f.git('commit','-m','advance'); f.git('push'); f.git('reset','--hard',head);
  const args=receiver(f); const result=f.run('--pane-dir',path.join(f.root,'isolated pane'));
  assert.equal(result.status,0,result.stderr);
  const calls=args(); const create=calls.find(a=>a.includes('create')); const list=calls.find(a=>a.includes('list'));
  assert.equal(create[create.indexOf('--base')+1],head);
  for(const call of [create,list]) assert.equal(call[call.indexOf('--pane-dir')+1],path.join(f.root,'isolated pane'));
});
