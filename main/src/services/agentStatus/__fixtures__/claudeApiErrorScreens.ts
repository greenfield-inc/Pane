/**
 * Claude Code 2.1.302 screens of a turn that ends on an API error, captured in tmux at 120
 * columns with ANTHROPIC_BASE_URL pointed at an unresolvable host (the project path is
 * shortened). An agent-farm worker wrapping Claude Code shows the same screens.
 */
const RULE = '─'.repeat(120);
const HEADER = [
  ' ▐▛███▛█   Claude Code v2.1.302',
  '▝▜██████▀  Haiku 5.5 · Claude Max',
  ' ▝▝   ▝▝   ~/repo',
  '',
  '❯ Reply with exactly OK.',
  '',
];
const IDLE_COMPOSER = [
  RULE,
  '❯ ',
  RULE,
  '   Model: Haiku 5.5  Ctx: 0 (0%)  repo  ✓ main',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
];

/** Still retrying: the turn is not over. */
export const CLAUDE_API_RETRYING_SCREEN = [
  ...HEADER,
  "✻ Can't reach the API server — check your internet or DNS (ENOTFOUND) · Retrying in 3s · attempt 7/10",
  '',
  ...IDLE_COMPOSER,
].join('\n');

/** The turn ended on the network error, after ten attempts. */
export const CLAUDE_API_ENOTFOUND_SCREEN = [
  ...HEADER,
  "⏺ API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
  '',
  '✻ Baked for 2m 52s · done 9:31 AM',
  '',
  ...IDLE_COMPOSER,
].join('\n');

/**
 * The turn ended because the computer slept mid-response. Claude Code 2.1.302 prints this with
 * the same `API Error:` prefix as the network error (its text is from the binary).
 */
export const CLAUDE_API_SLEEP_SCREEN = [
  ...HEADER,
  '⏺ API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
  '',
  '✻ Baked for 14m 3s · done 2:17 AM',
  '',
  ...IDLE_COMPOSER,
].join('\n');

/** The transcript line Claude Code 2.1.302 writes for the network error: a synthetic assistant message. */
export const CLAUDE_API_ENOTFOUND_TRANSCRIPT_LINE = JSON.stringify({
  parentUuid: 'a1f0c2d4-1b7e-4c55-9d1e-3f0b6f2e7a10',
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/Users/me/repo',
  sessionId: '67c1e1df-43fc-4d7c-a32d-4a25cdbdb99b',
  version: '2.1.302',
  gitBranch: 'main',
  type: 'assistant',
  uuid: 'c3d2b1a0-9f8e-4d7c-8b6a-5f4e3d2c1b0a',
  timestamp: '2026-10-17T16:31:00.000Z',
  isApiErrorMessage: true,
  error: 'server_error',
  message: {
    id: '468bfa5a-4c1a-4789-bbb9-4a38b9970745',
    model: '<synthetic>',
    role: 'assistant',
    stop_reason: 'stop_sequence',
    stop_sequence: '',
    type: 'message',
    content: [{ type: 'text', text: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" }],
  },
});
