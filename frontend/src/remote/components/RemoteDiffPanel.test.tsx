import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChangeList } from '../../../../shared/gitDiffClient';
import type { ToolPanel } from '../../../../shared/types/panels';
import { phoneShows } from '../stores/remoteSessionStore';
import { RemoteDiffView } from './RemoteDiffPanel';

const changes: ChangeList = {
  files: [
    { path: 'src/app.ts', kind: 'modified', additions: 1, deletions: 1, isBinary: false },
    { path: 'README.md', kind: 'added', additions: 3, deletions: 0, isBinary: false },
  ],
  resolvedBase: { kind: 'comparison-base', ref: 'refs/remotes/origin/main' },
  stats: { additions: 4, deletions: 1, filesChanged: 2 },
};
const patch = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n keep\n-const a = 1;\n+const a = 2;\n';
const noop = () => undefined;

describe('the PWA Diff tab', () => {
  it('is a tab the PWA shows, so View diff in a chat lands on it', () => {
    const diff: ToolPanel = { id: 'd1', sessionId: 'pane-1', type: 'diff', title: 'Diff', state: { isActive: false }, metadata: { createdAt: '', lastActiveAt: '', position: 1 } };
    expect(phoneShows(diff)).toBe(true);
  });

  it('lists the changed files and draws an opened file\'s patch', () => {
    const markup = renderToStaticMarkup(<RemoteDiffView changes={{ status: 'ready', value: changes }} open={new Set(['src/app.ts'])}
      patches={{ 'src/app.ts': { status: 'ready', value: { patch, status: 'changed' } } }} onToggle={noop} onRefresh={noop} />);
    expect(markup).toContain('2 files');
    expect(markup).toContain('vs main');
    expect(markup).toContain('README.md');
    expect(markup).toContain('-const a = 1;');
    expect(markup).toContain('+const a = 2;');
    expect(markup).not.toContain('+++ b/src/app.ts');
    expect(markup).toContain('Read-only here');
  });

  it('says when the branch has no changes, and when they cannot be read', () => {
    expect(renderToStaticMarkup(<RemoteDiffView changes={{ status: 'ready', value: { ...changes, files: [] } }} open={new Set()} patches={{}} onToggle={noop} onRefresh={noop} />))
      .toContain('This branch matches main.');
    expect(renderToStaticMarkup(<RemoteDiffView changes={{ status: 'error', message: 'This Pane is archived.' }} open={new Set()} patches={{}} onToggle={noop} onRefresh={noop} />))
      .toContain('This Pane is archived.');
  });
});
