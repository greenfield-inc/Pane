import type { AgentState } from '@shared/types/agentStatus';
import type { NotifyItem } from '@shared/types/notify';
import type { PaneChatAgent } from '@shared/types/paneChat';
import type { TailnetMachine } from '@shared/types/workspaceAccess';

// Invented sample content: a small web shop's repositories on one Mac. No real people, code or secrets.

const MINUTE = 60_000;
const ESC = '\x1b';
const dim = (text: string) => `${ESC}[90m${text}${ESC}[0m`;
const green = (text: string) => `${ESC}[32m${text}${ESC}[0m`;
const red = (text: string) => `${ESC}[31m${text}${ESC}[0m`;
const cyan = (text: string) => `${ESC}[36m${text}${ESC}[0m`;
const bold = (text: string) => `${ESC}[1m${text}${ESC}[0m`;
const step = (text: string) => `${green('●')} ${text}`;
const lines = (...rows: string[]) => rows.map(row => `${row}\r\n`).join('');

export interface DemoPaneSeed {
  id: string;
  name: string;
  projectId: number;
  baseBranch: string;
  favorite?: boolean;
  /** The agent tab's title and the command it runs; `null` for a Pane with only a shell. */
  agent: { title: string; type: string } | null;
  state: AgentState;
  minutesAgo: number;
  /** What the agent tab shows when you open it. */
  screen: string;
  /** Streamed after you open the agent tab, a line at a time; the agent then goes idle. */
  stream?: string[];
}

export const DEMO_PROJECTS = [
  { id: 1, name: 'acme-web', path: '/Users/you/code/acme-web' },
  { id: 2, name: 'acme-api', path: '/Users/you/code/acme-api' },
];

export const DEMO_PANES: DemoPaneSeed[] = [
  {
    id: 'demo-fix-checkout-race', name: 'fix-checkout-race', projectId: 1, baseBranch: 'origin/main', favorite: true,
    agent: { title: 'Claude Code', type: 'claude' }, state: 'working', minutesAgo: 3,
    screen: lines(
      `${dim('~/code/acme-web')} on ${cyan('fix-checkout-race')}`,
      `${bold('>')} Two tabs can pay for one cart.`,
      '  Find the race and fix it.',
      '',
      step('Read(src/checkout/submitOrder.ts)'),
      step(`Search("reserveCart")  ${dim('4 results')}`),
      step('Both requests pass the read before'),
      '  either marks the cart paid. I’ll',
      '  lock the cart row before charging.',
      step(`Edit(submitOrder.ts)  ${green('+14')} ${red('-3')}`),
      step('Bash(pnpm test checkout)'),
    ),
    stream: [
      `  ${green('✓')} charges a cart once ${dim('(12 ms)')}`,
      `  ${green('✓')} second tab sees "paid" ${dim('(9 ms)')}`,
      `  ${green('✓')} unlocks on a declined card ${dim('(7 ms)')}`,
      `  Tests  ${green('18 passed')} (18)`,
      '',
      step('One charge per cart now. Shall I'),
      '  add a test for the retry path too?',
      '',
      `${bold('>')} `,
    ],
  },
  {
    id: 'demo-dark-mode', name: 'add-dark-mode', projectId: 1, baseBranch: 'origin/main',
    agent: { title: 'Codex', type: 'codex' }, state: 'blocked', minutesAgo: 6,
    screen: lines(
      `${dim('~/code/acme-web')} on ${cyan('add-dark-mode')}`,
      `${bold('›')} Add a dark theme to the store.`,
      '',
      `${dim('•')} Read tailwind.config.ts, tokens.css`,
      `${dim('•')} 41 hard-coded colors, 12 components`,
      `${dim('•')} Asked you: which colors for dark?`,
      '',
      dim('  Waiting for your answer…'),
    ),
  },
  {
    id: 'demo-react-19', name: 'upgrade-react-19', projectId: 1, baseBranch: 'origin/main',
    agent: { title: 'Claude Code', type: 'claude' }, state: 'working', minutesAgo: 14,
    screen: lines(
      `${dim('~/code/acme-web')} on ${cyan('upgrade-react-19')}`,
      `${bold('>')} Upgrade to React 19; fix breaks.`,
      '',
      step('Bash(pnpm add react@19 react-dom@19)'),
      step(`Edit(providers.tsx)  ${green('+6')} ${red('-9')}`),
      step('Bash(pnpm typecheck && pnpm test)'),
      `  Tests  ${green('212 passed')} (212)`,
      step('Opened PR #128. Checks are green.'),
      '',
      `${bold('>')} `,
    ),
  },
  {
    id: 'demo-copy-review', name: 'review-product-copy', projectId: 1, baseBranch: 'origin/main',
    agent: { title: 'review-bot', type: 'custom' }, state: 'idle', minutesAgo: 42,
    screen: lines(
      `${dim('$')} ./bin/review-bot src/pages`,
      'Checked 18 pages.',
      `  ${green('ok')}    product/[slug].tsx`,
      `  ${red('long')}  compare.tsx: title 74/60`,
      `${dim('$')} `,
    ),
  },
  {
    id: 'demo-rate-limit', name: 'rate-limit-retries', projectId: 2, baseBranch: 'origin/main',
    agent: { title: 'Codex', type: 'codex' }, state: 'blocked', minutesAgo: 9,
    screen: lines(
      `${dim('~/code/acme-api')} on ${cyan('rate-limit-retries')}`,
      `${bold('›')} Retry payment 429s with backoff.`,
      '',
      `${dim('•')} Added retryWithBackoff()`,
      `${dim('•')} Wrote migration 0042_retry_log`,
      `${dim('•')} Asked you: apply it to staging?`,
    ),
  },
  {
    id: 'demo-api-shell', name: 'api-dev-server', projectId: 2, baseBranch: 'main',
    agent: null, state: 'idle', minutesAgo: 75,
    screen: lines(
      `${dim('$')} pnpm dev`,
      `${green('ready')} API on http://localhost:4000`,
      `${dim('GET  /health 200 2 ms')}`,
      `${dim('POST /orders 201 48 ms')}`,
    ),
  },
];

/** The shell tab every Pane also has. */
export function shellScreen(pane: DemoPaneSeed): string {
  const folder = DEMO_PROJECTS.find(project => project.id === pane.projectId)?.name ?? 'project';
  return lines(`${dim(`~/code/${folder}`)} on ${cyan(pane.name)}`, `${dim('$')} git status --short`, ' M src/checkout/submitOrder.ts', `${dim('$')} `);
}

export const DEMO_SESSION = {
  id: '__orchestration_session_demo-launch__',
  name: 'Spring sale launch',
  agent: 'claude' as PaneChatAgent,
  goal: 'Ship the checkout fix and dark mode before the spring sale.',
  screen: lines(
    `${bold('>')} What is left before the sale?`,
    '',
    step('fix-checkout-race: tests pass.'),
    step('add-dark-mode: needs a color pick.'),
    step('rate-limit-retries: wants approval'),
    '  for a staging migration.',
    '',
    'Two decisions are yours. The rest',
    'is moving.',
    '',
    `${bold('>')} `,
  ),
};

export function demoMachines(): TailnetMachine[] {
  const machine = (name: string, os: TailnetMachine['os'], state: TailnetMachine['state']): TailnetMachine => ({
    name, os, state, dnsName: `${name}.demo.invalid`, url: `https://${name}.demo.invalid`, ownerLogin: 'you@example.com', mine: true, paneVersion: '2.4.207',
  });
  return [machine('studio-mac', 'macOS', 'available'), machine('build-box', 'Linux', 'available'), machine('travel-laptop', 'macOS', 'offline')];
}

export function demoNotifyItems(now: number): NotifyItem[] {
  return [
    {
      id: 'demo-q-colors', ui: 'options', state: 'waiting', createdAt: now - 6 * MINUTE,
      title: 'Which colors should dark mode use?',
      context: 'The storefront has 41 hard-coded colors. The design system already defines dark tokens for most of them.',
      choices: [
        { label: 'Design-system tokens', detail: 'Swap the 41 colors for tokens. Smallest change.', recommended: true },
        { label: 'New dark palette', detail: 'A fresh set just for the storefront.' },
        { label: 'Follow the OS only', detail: 'No toggle; match the phone or computer setting.' },
      ],
      source: { paneId: 'demo-dark-mode', panelId: 'demo-dark-mode-agent', name: 'add-dark-mode', agent: 'Codex' },
    },
    {
      id: 'demo-q-migration', ui: 'approve', state: 'waiting', createdAt: now - 9 * MINUTE,
      title: 'Apply migration 0042 to staging?',
      context: 'Adds a retry_log table. Staging only; production waits for review.',
      detail: 'CREATE TABLE retry_log (\n  id bigserial PRIMARY KEY,\n  request_id text NOT NULL,\n  attempt int NOT NULL,\n  created_at timestamptz DEFAULT now()\n);',
      detailLabel: 'Show the SQL',
      source: { paneId: 'demo-rate-limit', panelId: 'demo-rate-limit-agent', name: 'rate-limit-retries', agent: 'Codex' },
    },
    {
      id: 'demo-u-pr', ui: 'info', state: 'info', createdAt: now - 2 * MINUTE,
      title: 'PR #128 checks passed',
      source: { paneId: 'demo-react-19', panelId: 'demo-react-19-agent', name: 'upgrade-react-19', agent: 'Claude' },
    },
    {
      id: 'demo-h-copy', ui: 'ask', state: 'answered', createdAt: now - 50 * MINUTE, resolvedAt: now - 45 * MINUTE,
      title: 'What should the sale banner say?', answerSummary: 'Spring sale: 20% off everything',
      source: { paneId: 'demo-copy-review', name: 'review-product-copy', agent: 'review-bot' },
    },
  ];
}

/** A reply the sample agents give to anything you send them. */
export function demoReply(agentType: string | undefined, text: string): string[] {
  if (!agentType) return [`${(text.split(' ')[0] || 'command').slice(0, 16)}: sample shell, nothing runs`, `${dim('$')} `];
  return [
    step('Read(src/checkout/submitOrder.ts)'),
    step(`Got it: “${text.length > 26 ? `${text.slice(0, 25)}…` : text}”.`),
    '  Working on it now.',
    dim('  (Sample agent: nothing runs.)'),
    '',
    `${bold('>')} `,
  ];
}
