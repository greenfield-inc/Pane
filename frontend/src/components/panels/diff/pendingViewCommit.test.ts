import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPendingViewCommit,
  setPendingViewCommit,
  takePendingViewCommit,
  viewCommitScope,
} from './pendingViewCommit';

const older = '1234567890abcdef1234567890abcdef12345678';
const newer = 'abcdef0123456789abcdef0123456789abcdef01';

describe('pendingViewCommit', () => {
  afterEach(() => clearPendingViewCommit());

  it('retains a commit until the matching session consumes it', () => {
    setPendingViewCommit('session-a', { commitHash: 'abc123' });

    expect(takePendingViewCommit('session-b')).toBeNull();
    expect(takePendingViewCommit('session-a')).toEqual({ commitHash: 'abc123' });
    expect(takePendingViewCommit('session-a')).toBeNull();
  });

  it('replaces an older pending commit', () => {
    setPendingViewCommit('session-a', { commitHash: 'abc123' });
    setPendingViewCommit('session-b', { commitHash: 'def456', olderHash: 'abc123' });

    expect(takePendingViewCommit('session-a')).toBeNull();
    expect(takePendingViewCommit('session-b')).toEqual({ commitHash: 'def456', olderHash: 'abc123' });
  });
});

describe('viewCommitScope', () => {
  it('opens a single commit or the working tree without an older end', () => {
    expect(viewCommitScope({ commitHash: newer })).toEqual({ kind: 'commit', hash: newer });
    expect(viewCommitScope({ commitHash: 'index' })).toEqual({ kind: 'working-tree' });
  });

  it('opens a commit range from the older end to the newer end', () => {
    expect(viewCommitScope({ commitHash: newer, olderHash: older }))
      .toEqual({ kind: 'commit-range', olderHash: older, newerHash: newer });
  });

  it('opens a working-tree range when the newer end is the uncommitted row', () => {
    expect(viewCommitScope({ commitHash: 'index', olderHash: older }))
      .toEqual({ kind: 'working-tree-range', baseHash: older });
  });

  it('treats a range whose ends match as that one commit', () => {
    expect(viewCommitScope({ commitHash: newer, olderHash: newer })).toEqual({ kind: 'commit', hash: newer });
  });
});
