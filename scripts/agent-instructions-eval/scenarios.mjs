// Scenarios for the agent-instructions eval. Each one stages a repository, a Pane role and a task,
// scripts what Pane answers, and grades only what the agent did through public interfaces: the
// runpane CLI and `pane` MCP calls it made, its Bash commands and the files it wrote.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** The notify calls that post a new card: not a reply's took/update or a resume. */
const cards = (run) => run.calls.filter(({ argv }) => argv[0] === 'notify' && !argv.some((a) => ['--took', '--update', '--resume', '--help', '-h'].includes(a)));
const has = (run, ...words) => run.calls.some(({ argv }) => words.every((word, i) => argv[i] === word));
const flagValue = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const json = (text) => { try { return JSON.parse(text ?? ''); } catch { return undefined; } };
const askedInChat = (run) => run.tools.some((tool) => tool.name === 'AskUserQuestion');
const bashMatches = (run, pattern) => run.bash.some((command) => pattern.test(command));

/** Fails unless every check holds; the first failing check names why. */
function verdict(checks) {
  const failed = checks.find(([ok]) => !ok);
  return failed ? { pass: false, why: failed[1] } : { pass: true, why: 'all checks held' };
}

/** A card the way the notify rules describe it: one-line title, context, 2-4 choices with exactly one recommended. */
function wellFormedCard(argv) {
  const title = flagValue(argv, '--title') ?? '';
  const context = flagValue(argv, '--context') ?? '';
  const questions = json(flagValue(argv, '--questions'));
  const groups = Array.isArray(questions) ? questions.map((q) => q.choices ?? []) : [json(flagValue(argv, '--choices')) ?? []];
  const choicesOk = groups.every((choices) => choices.length >= 2 && choices.length <= 4
    && choices.filter((choice) => choice.recommended === true).length === 1);
  return [
    [title.length > 0 && title.length <= 160 && !title.includes('\n'), `title "${title}" is empty, over 160 characters or has a line break`],
    [context.length > 0, 'no context'],
    [choicesOk, '2-4 choices with exactly one recommended (per question) not met'],
  ];
}

/** Multi-part work inside a Session: Panes created (Pane associates them with the caller's Session), no new Session, no opt-out. */
const joinsSession = (run) => [
  [run.calls.some(({ argv }) => (argv[0] === 'panes' && argv[1] === 'create') || (argv[0] === 'agents' && argv[1] === 'start' && !argv.includes('--pane'))), 'never created a Pane'],
  [!has(run, 'sessions', 'create'), 'created a new Session'],
  [!run.calls.some(({ argv }) => argv.includes('--no-associate')), 'opted out of joining the Session with --no-associate'],
];

const pkg = (repo, extra = {}) => write(path.join(repo, 'package.json'), `${JSON.stringify({ name: 'ledger', version: '0.1.0', scripts: { test: 'node test.js' }, ...extra }, null, 2)}\n`);

export const SCENARIOS = [
  {
    id: 'worker-reports-blocked',
    title: 'A Session worker that needs a decision reports blocked with runpane report and does not call notify',
    role: 'worker',
    setup({ repo, sessionDir }) {
      pkg(repo);
      write(path.join(sessionDir, 'items', 'rename.md'), `# Rename the package before the first publish\n\nPublish this package to npm under its new name: either \`ledger-core\` or \`@acme/ledger\`. The person hasn't said which, nothing in the repo decides it, and a published name can't be taken back.\n\n1. Settle the name.\n2. Set it in package.json and commit. Don't publish.\n\nParent status file: ${path.join(sessionDir, '.agent', 'workers', 'rename.json')}\n`);
    },
    prompt: ({ sessionDir }) => `Read and follow your brief: ${path.join(sessionDir, 'items', 'rename.md')}`,
    script: () => ({ notify: [{ unavailable: 'You are a worker in a Session, so Pane does not show your notify card.', next: 'Report blocked with runpane report --state blocked --question "<question>" instead.' }] }),
    grade: (run) => verdict([
      [run.calls.some(({ argv }) => argv[0] === 'report' && flagValue(argv, '--state') === 'blocked' && flagValue(argv, '--question')), 'no runpane report --state blocked --question'],
      [cards(run).length === 0, `called notify ${cards(run).length} time(s)`],
      [!askedInChat(run), 'used AskUserQuestion'],
    ]),
  },
  {
    id: 'orchestrator-posts-one-card',
    title: 'A Session orchestrator posts one approval card: title, context, 2-4 choices with one recommended, and links',
    role: 'orchestrator',
    setup({ repo, sessionDir }) {
      pkg(repo);
      write(path.join(sessionDir, 'plan.html'), '<!doctype html><title>Search plan</title><h1>Search speed-up</h1><p>Option A: add a database index. Option B: add a cache in front of search.</p>');
    },
    prompt: ({ sessionDir }) => `You orchestrate this Pane Session. The plan at ${path.join(sessionDir, 'plan.html')} has two approaches to speed up search: A adds a database index (changes the live database), B adds an in-memory cache (no migration, stale results for up to a minute). You can't dispatch the workers until the person picks one, and they are away from this chat. Get their decision.`,
    script: () => ({}),
    grade: (run) => {
      const posted = cards(run);
      return verdict([
        [posted.length === 1, `posted ${posted.length} cards`],
        ...(posted.length === 1 ? wellFormedCard(posted[0].argv) : []),
        [posted.length === 1 && (json(flagValue(posted[0].argv, '--links')) ?? []).length > 0, 'no links'],
        [!askedInChat(run), 'used AskUserQuestion'],
      ]);
    },
  },
  {
    id: 'standalone-asks-via-notify',
    title: 'A standalone agent asks via notify, not in the terminal',
    role: 'pane',
    setup: ({ repo }) => pkg(repo),
    prompt: () => "Set this package's npm name for its first publish. It's either ledger-core or @acme/ledger and I haven't decided; a published name can't be taken back. I'm stepping away from the keyboard now.",
    script: () => ({}),
    grade: (run) => verdict([
      [cards(run).some(({ argv }) => ['options', 'approve', 'ask'].includes(flagValue(argv, '--ui'))), 'never asked through notify'],
      [!askedInChat(run), 'used AskUserQuestion'],
    ]),
  },
  {
    id: 'api-key-via-secrets-request',
    title: 'An API key request uses secrets_request, never ask',
    role: 'pane',
    setup({ repo }) {
      pkg(repo, { scripts: { 'test:stripe': 'node stripe.test.js' } });
      write(path.join(repo, 'stripe.test.js'), "if (!process.env.STRIPE_TEST_KEY) { console.error('STRIPE_TEST_KEY is not set'); process.exit(1); }\nconsole.log('stripe ok');\n");
    },
    prompt: () => "Run the Stripe integration test (npm run test:stripe). It needs a Stripe test-mode API key in STRIPE_TEST_KEY, which you don't have. I'm away; get what you need from me and run it.",
    script: () => ({ 'secrets request': { status: 'saved', project: 'ledger', name: 'STRIPE_TEST_KEY' }, 'secrets exec': { env: { STRIPE_TEST_KEY: 'sk_test_eval' } } }),
    grade: (run) => verdict([
      [has(run, 'secrets', 'request'), 'never ran runpane secrets request / secrets_request'],
      [!cards(run).some(({ argv }) => flagValue(argv, '--ui') === 'ask'), 'asked for it with notify --ui ask'],
      [!askedInChat(run), 'used AskUserQuestion'],
    ]),
  },
  {
    id: 'info-sparingly',
    title: 'Routine work with nothing to decide sends at most one info update and no other card',
    role: 'pane',
    setup({ repo }) {
      pkg(repo);
      write(path.join(repo, 'src', 'a.js'), 'let cnt = 0;\nmodule.exports = () => ++cnt;\n');
      write(path.join(repo, 'src', 'b.js'), 'const cnt = require("./a");\nmodule.exports = cnt;\n');
      write(path.join(repo, 'test.js'), 'const b = require("./src/b");\nif (b() !== 1) process.exit(1);\nconsole.log("ok");\n');
    },
    prompt: () => 'Rename the variable `cnt` to `count` in src/a.js and src/b.js, run the tests (npm test) and commit. I am away for the next hour.',
    script: () => ({}),
    grade: (run) => {
      const infos = cards(run).filter(({ argv }) => flagValue(argv, '--ui') === 'info').length;
      return verdict([
        [infos <= 1, `sent ${infos} info updates`],
        [cards(run).length === infos, 'posted a question card although nothing needed deciding'],
      ]);
    },
  },
  {
    id: 'relay-and-ack',
    title: "A Session orchestrator relays a worker's question with --relays and acks the answer",
    role: 'orchestrator',
    setup: ({ repo }) => pkg(repo),
    prompt: () => "You orchestrate this Pane Session. Worker 'rename' reported blocked; its question is inbox item it-7: it needs the person to choose the npm name, ledger-core or @acme/ledger, before it commits (a published name can't be taken back). Get the person's answer to the worker and record it.",
    script: () => ({
      inbox: { ok: true, session: { id: 's-eval', name: 'settings' }, items: [{ id: 'it-7', sessionId: 's-eval', kind: 'report', at: '2026-11-13T09:00:00.000Z', paneId: 'p-rename', paneName: 'rename', panelId: 'pl-rename', report: { state: 'blocked', question: 'Which npm name should the package be published under: ledger-core or @acme/ledger? A published name cannot be taken back.', reportedAt: '2026-11-13T09:00:00.000Z' } }] },
      'inbox ack': { ok: true, acknowledged: ['it-7'], unknown: [] },
      notify: [{ answer: '@acme/ledger' }],
    }),
    grade: (run) => {
      const relayed = cards(run).filter(({ argv }) => flagValue(argv, '--relays') === 'it-7');
      return verdict([
        [relayed.length >= 1, 'no notify --relays it-7'],
        [cards(run).length === relayed.length, 'posted a second card instead of relaying'],
        [run.calls.some(({ argv }) => argv[0] === 'inbox' && argv[1] === 'ack' && argv.includes('it-7')), 'never ran runpane inbox ack it-7'],
      ]);
    },
  },
  {
    id: 'typed-reply-question',
    title: 'A typed reply that is a question is handled with --took question and --update, not a second card',
    role: 'pane',
    setup({ repo, runDir }) {
      pkg(repo);
      const origin = path.join(runDir, 'origin.git');
      execFileSync('git', ['init', '-q', '--bare', origin]);
      git(repo, 'remote', 'add', 'origin', origin);
      git(repo, '-c', 'user.email=eval@example.com', '-c', 'user.name=eval', 'commit', '-qm', '1.x history', '--allow-empty');
      git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/legacy');
    },
    prompt: () => 'Delete the `legacy` branch on origin once I approve it: it holds the 1.x release history. Get my approval first, I am away from this chat.',
    script: () => ({
      notify: [
        { reply: 'Can we get it back later if we need it?', picks: [], id: 'n-1', replyId: 'r-1', next: 'The person typed a reply. If it answers, run runpane notify --took r-1 answer; if it asks, run runpane notify --took r-1 question, find out, then runpane notify --update r-1 --asked "<their question>" --what-changed "<one line per change>".' },
        { approved: true },
        { approved: true },
      ],
    }),
    grade: (run) => verdict([
      [run.calls.some(({ argv }) => argv[0] === 'notify' && argv.includes('--took') && argv.includes('question')), 'never ran notify --took <id> question'],
      [run.calls.some(({ argv }) => argv[0] === 'notify' && argv.includes('--update')), 'never ran notify --update'],
      [cards(run).length === 1, `posted ${cards(run).length} cards`],
    ]),
  },
  {
    id: 'session-for-multipart-work',
    title: 'A multi-part piece of work is organised in a Session (the default)',
    role: 'pane',
    setup: ({ repo }) => pkg(repo),
    prompt: () => 'Kick off the settings overhaul: three parts that can run in parallel, (1) migrate the settings schema, (2) rebuild the settings UI, (3) write the docs. Use a few agents and set it up in Pane so I can follow along; I will check in later.',
    script: () => ({}),
    grade: (run) => verdict([
      [has(run, 'sessions', 'create'), 'never created a Session'],
    ]),
  },
  {
    id: 'orchestrator-multipart-joins-session',
    title: "A Session orchestrator asked for multi-part work creates Panes in its own Session, not a new Session",
    role: 'orchestrator',
    setup: ({ repo }) => pkg(repo),
    prompt: () => 'Kick off the settings overhaul: three parts that can run in parallel, (1) migrate the settings schema, (2) rebuild the settings UI, (3) write the docs. Use a few agents; I will check in later.',
    script: () => ({}),
    grade: (run) => verdict(joinsSession(run)),
  },
  {
    id: 'session-pane-multipart-joins-session',
    title: "An agent in a Pane that belongs to a Session, asked for multi-part work, creates Panes in that Session, not a new Session",
    // The worker role is a tab in a Pane that belongs to a Session: PANE_SESSION_DIR set, no PANE_ORCHESTRATION_SESSION_ID.
    role: 'worker',
    setup({ repo }) {
      pkg(repo);
      write(path.join(repo, 'src', 'tokens.css'), ':root {\n  --bg: #ffffff;\n  --fg: #111111;\n  --accent: #2255ee;\n}\n');
      write(path.join(repo, 'src', 'components', 'Button.js'), "module.exports = (label) => `<button style=\"background:#2255ee;color:#fff\">${label}</button>`;\n");
      write(path.join(repo, 'src', 'components', 'Card.js'), "module.exports = (body) => `<div style=\"background:#fff;color:#111\">${body}</div>`;\n");
      write(path.join(repo, 'docs', 'components.md'), '# Components\n\n![Button](screenshots/button.png)\n![Card](screenshots/card.png)\n');
    },
    prompt: () => 'We need dark mode: new colour tokens, every component updated to use them, and fresh screenshots for the docs. Get it going with a few agents.',
    script: () => ({}),
    grade: (run) => verdict(joinsSession(run)),
  },
  {
    id: 'new-feature-gets-a-pane',
    title: 'A new feature gets its own Pane (worktree), not a tab or a hand-made worktree',
    role: 'pane',
    setup: ({ repo }) => pkg(repo),
    prompt: () => 'Start a separate agent on a new feature: CSV export for the ledger. It is unrelated to what this Pane is working on. Set it up in Pane and leave it running.',
    script: () => ({}),
    grade: (run) => verdict([
      [has(run, 'panes', 'create') || run.calls.some(({ argv }) => argv[0] === 'agents' && argv[1] === 'start' && !argv.includes('--pane')), 'never created a Pane'],
      [!has(run, 'panels', 'create'), 'opened a tab in an existing Pane'],
      [!bashMatches(run, /git\s+worktree\s+add|git\s+clone/), 'made a git worktree or clone by hand'],
    ]),
  },
  {
    id: 'rerun-is-a-tab',
    title: 'QA for a feature that already has a Pane becomes a new tab in that Pane',
    role: 'pane',
    setup({ repo, runDir }) {
      pkg(repo);
      const worktree = path.join(runDir, 'worktrees', 'search-speedup');
      git(repo, 'worktree', 'add', '-q', '-b', 'search-speedup', worktree);
      return { worktree };
    },
    prompt: () => 'PR #42 (branch search-speedup) is ready for QA. Start a QA agent on it in Pane and leave it running.',
    script: ({ worktree }) => ({
      'panes list': { ok: true, panes: [{ id: 'p-search', paneId: 'p-search', name: 'search-speedup', status: 'idle', worktreePath: worktree, repoId: 1, panelCount: 1, pinned: true, agentStatus: 'idle', ownership: 'pane' }] },
      gh: { headRefName: 'search-speedup', number: 42, state: 'OPEN' },
    }),
    grade: (run) => verdict([
      [run.calls.some(({ argv }) => (argv[0] === 'panels' && argv[1] === 'create' && argv.includes('p-search')) || (argv[0] === 'agents' && argv[1] === 'start' && argv.includes('p-search'))), 'did not open a tab in Pane p-search'],
      [!has(run, 'panes', 'create'), 'created a new Pane'],
      [!bashMatches(run, /git\s+worktree\s+add|git\s+clone/), 'made a git worktree or clone by hand'],
    ]),
  },
  {
    id: 'scratch-stays-in-worktree',
    title: 'Scratch copies, captures and reports go in $PANE_SCRATCH_DIR, never system temp',
    role: 'pane',
    setup({ repo }) {
      pkg(repo, { scripts: { build: 'node build.js' } });
      write(path.join(repo, 'build.js'), "console.log('built ledger');\n");
      write(path.join(repo, '.gitignore'), 'tmp/\nnode_modules/\n');
    },
    prompt: () => 'Before we change the build, try it on a throwaway copy of this repository: copy the repo, run npm run build in the copy, capture the output to a file, and write a short report of what you saw. Keep the report and the capture for me.',
    script: () => ({}),
    grade: (run) => verdict([
      [run.tempPaths.length === 0, `used system temp: ${run.tempPaths.slice(0, 3).join(', ')}`],
      [run.writes.length > 0 || bashMatches(run, />|cp\s|tee\s/), 'wrote nothing'],
      [run.scratchUse, 'never used $PANE_SCRATCH_DIR'],
    ]),
  },
  {
    id: 'ask-only-what-you-cannot-find',
    title: 'An agent does not ask what the repository already answers',
    role: 'pane',
    setup({ repo }) {
      pkg(repo, { packageManager: 'pnpm@10.0.0' });
      write(path.join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    },
    prompt: () => "Add a `ci` script to package.json that runs the tests through this repo's package manager. I'm away; just do it.",
    script: () => ({}),
    grade: (run) => verdict([
      [cards(run).filter(({ argv }) => flagValue(argv, '--ui') !== 'info').length === 0, 'asked the person'],
      [!askedInChat(run), 'used AskUserQuestion'],
    ]),
  },
  {
    id: 'related-questions-one-card',
    title: 'Two related decisions go in one card',
    role: 'pane',
    setup: ({ repo }) => { pkg(repo); write(path.join(repo, 'config.json'), '{}\n'); },
    prompt: () => "Set up the new search endpoint in config.json. Two things I haven't decided: its path (/v2/search or /search?version=2) and the default page size (20 or 50). Ask me; I'm away from this chat.",
    script: () => ({ notify: [{ answers: ['/v2/search', '20'], answer: '/v2/search' }] }),
    grade: (run) => verdict([
      [cards(run).filter(({ argv }) => flagValue(argv, '--ui') !== 'info').length === 1, `posted ${cards(run).length} cards`],
    ]),
  },
  {
    id: 'waiting-then-resume',
    title: 'A waiting result is resumed, not reposted',
    role: 'pane',
    setup: ({ repo }) => pkg(repo),
    prompt: () => "Set this package's npm name for its first publish: ledger-core or @acme/ledger. I haven't decided and a published name can't be taken back. Ask me; I'm away from this chat.",
    script: () => ({ notify: [{ waiting: true, id: 'n-9', next: 'Call runpane notify --resume n-9 to keep waiting.' }, { answer: '@acme/ledger' }] }),
    grade: (run) => verdict([
      [run.calls.some(({ argv }) => argv[0] === 'notify' && flagValue(argv, '--resume') === 'n-9'), 'never resumed n-9'],
      [cards(run).length === 1, `posted ${cards(run).length} cards`],
    ]),
  },
  {
    id: 'unavailable-asks-in-terminal',
    title: 'When notify is unavailable the agent asks in the terminal instead of retrying',
    role: 'pane',
    setup: ({ repo }) => pkg(repo),
    prompt: () => "Set this package's npm name for its first publish: ledger-core or @acme/ledger. I haven't decided and a published name can't be taken back.",
    script: () => ({ notify: [{ unavailable: 'Pane is not running, so nobody can answer through it right now.', next: 'Ask in the terminal instead.' }] }),
    grade: (run) => verdict([
      [cards(run).length <= 2, `posted ${cards(run).length} cards`],
      [/ledger-core/.test(run.text) && /@acme\/ledger/.test(run.text) && /\?/.test(run.text), 'final message does not ask the person to choose between the two names'],
    ]),
  },
  // Harder variants of the Pane-primitives scenarios: the prompt names no primitive and no id.
  {
    id: 'review-rerun-bare',
    title: 'A bare "rerun the review" inside a feature\'s Pane opens a tab in that Pane',
    role: 'pane',
    setup: ({ repo }) => { pkg(repo); git(repo, 'checkout', '-q', '-b', 'csv-export'); },
    prompt: () => 'Rerun the review on this and leave it going.',
    script: ({ repo }) => ({ 'panes list': { ok: true, panes: [{ id: 'p-feature', paneId: 'p-feature', name: 'csv-export', status: 'idle', worktreePath: repo, repoId: 1, panelCount: 1, pinned: true, agentStatus: 'idle', ownership: 'pane' }] } }),
    grade: (run) => verdict([
      // panels create defaults to the caller's Pane ($PANE_SESSION_ID); agents start without --pane makes a new one.
      [run.calls.some(({ argv }) => (argv[0] === 'panels' && argv[1] === 'create' && (!argv.includes('--pane') || argv.includes('p-feature')))
        || (argv[0] === 'agents' && argv[1] === 'start' && argv.includes('p-feature'))), 'did not open a tab in this Pane'],
      [!has(run, 'panes', 'create'), 'created a new Pane'],
      [!bashMatches(run, /git\s+worktree\s+add|git\s+clone/), 'made a git worktree or clone by hand'],
    ]),
  },
  {
    id: 'qa-fresh-copy',
    title: 'QA asked as "spin up a fresh copy" runs in this Pane, with the copy in $PANE_SCRATCH_DIR',
    role: 'pane',
    setup: ({ repo }) => { pkg(repo, { scripts: { start: 'node server.js' } }); write(path.join(repo, 'server.js'), "console.log('ledger on :4100');\n"); },
    prompt: () => 'Spin up a fresh copy of the app and QA the start-up on it. Keep whatever you capture for me.',
    script: () => ({}),
    grade: (run) => verdict([
      [!has(run, 'panes', 'create'), 'created a new Pane'],
      [!bashMatches(run, /git\s+worktree\s+add/), 'made a git worktree by hand'],
      [run.tempPaths.length === 0, `used system temp: ${run.tempPaths.slice(0, 3).join(', ')}`],
      [run.scratchUse, 'never used $PANE_SCRATCH_DIR'],
    ]),
  },
  {
    id: 'research-clone',
    title: 'Research that needs a clone puts it in $PANE_SCRATCH_DIR, unprompted',
    role: 'pane',
    setup({ repo, runDir }) {
      pkg(repo);
      const upstream = path.join(runDir, 'upstream');
      fs.mkdirSync(upstream, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: upstream });
      write(path.join(upstream, 'pad.js'), 'module.exports = (s, n, c = " ") => String(s).padStart(n, c);\n');
      git(upstream, 'add', '-A');
      git(upstream, '-c', 'user.email=eval@example.com', '-c', 'user.name=eval', 'commit', '-qm', 'pad');
      return { upstream };
    },
    prompt: ({ upstream }) => `Find out how the padding library at ${upstream} pads strings: clone it, read the code, and write me a short note with what you found.`,
    script: () => ({}),
    grade: (run) => verdict([
      [bashMatches(run, /git\s+clone/), 'never cloned'],
      [run.tempPaths.length === 0, `used system temp: ${run.tempPaths.slice(0, 3).join(', ')}`],
      // `git clone <src> "$PANE_SCRATCH_DIR/x"` or `cd "$PANE_SCRATCH_DIR" && git clone <src> x`.
      [run.bash.some((command) => /git\s+clone/.test(command) && /PANE_SCRATCH_DIR|\.pane\/scratch/.test(command)), 'did not clone into $PANE_SCRATCH_DIR'],
    ]),
  },
  {
    id: 'multipart-no-pane-mention',
    title: 'A multi-part ask that never mentions Pane, without the pane skill, still starts a Session',
    role: 'pane',
    noSkill: true,
    setup: ({ repo }) => pkg(repo),
    prompt: () => 'We need dark mode: new colour tokens, every component updated to use them, and fresh screenshots for the docs. Get it going with a few agents.',
    script: () => ({}),
    grade: (run) => verdict([
      [has(run, 'sessions', 'create'), 'never created a Session'],
    ]),
  },
  {
    id: 'doctor-only',
    title: 'An agent that read only runpane doctor states where a review rerun and a research clone go',
    role: 'pane',
    noSkill: true,
    setup: ({ repo }) => pkg(repo),
    prompt: () => 'Run `runpane doctor`. Then, without doing anything else, answer in two short lines: where would you run a rerun of this feature\'s review, and where would you put a repository you clone for research?',
    script: () => ({}),
    grade: (run) => verdict([
      [has(run, 'doctor'), 'never ran runpane doctor'],
      [/\btab\b|panels create/i.test(run.text), 'did not say the rerun is a tab in this Pane'],
      [/PANE_SCRATCH_DIR|\.pane\/scratch/.test(run.text), 'did not name $PANE_SCRATCH_DIR for the clone'],
    ]),
  },
];
