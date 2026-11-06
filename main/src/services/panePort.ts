/**
 * PANE_PORT: deterministic port block per Pane (10 consecutive ports), so
 * parallel worktree dev servers do not collide. The Pane ID hashes to a port in
 * the 3000-8990 range (600 blocks of 10).
 * Usage in pane.json: { "scripts": { "run": "PORT=$PANE_PORT pnpm dev" } }
 */
export function panePortFor(sessionId: string): number {
  let hash = 0;
  for (let index = 0; index < sessionId.length; index++) {
    hash = ((hash << 5) - hash) + sessionId.charCodeAt(index);
    hash |= 0;
  }
  return 3000 + (Math.abs(hash) % 600) * 10;
}
