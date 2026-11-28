import { describe, expect, it } from 'vitest';
import { reconcileFromDisk } from './profileDiskSync';

describe('reconcileFromDisk', () => {
  it('reads a file the tab has not read yet', () => {
    expect(reconcileFromDisk({}, 'a')).toEqual({ saved: 'a' });
  });

  it('changes nothing when the disk matches what the tab last read', () => {
    expect(reconcileFromDisk({ saved: 'a' }, 'a')).toEqual({ saved: 'a' });
    expect(reconcileFromDisk({ saved: 'a', draft: 'mine' }, 'a')).toEqual({ saved: 'a', draft: 'mine' });
  });

  it('shows a change made outside Pane when there are no unsaved edits', () => {
    expect(reconcileFromDisk({ saved: 'a' }, 'b')).toEqual({ saved: 'b' });
  });

  it('keeps unsaved edits and flags the change on disk', () => {
    expect(reconcileFromDisk({ saved: 'a', draft: 'mine' }, 'b')).toEqual({ saved: 'a', draft: 'mine', onDisk: 'b' });
  });

  it('drops the flag when the disk changes to what you typed', () => {
    expect(reconcileFromDisk({ saved: 'a', draft: 'b', onDisk: 'c' }, 'b')).toEqual({ saved: 'b' });
  });

  it('keeps an earlier flag up to date as the disk changes again', () => {
    expect(reconcileFromDisk({ saved: 'a', draft: 'mine', onDisk: 'b' }, 'c')).toEqual({ saved: 'a', draft: 'mine', onDisk: 'c' });
  });

  it('flags a removed file only when you have unsaved edits in it', () => {
    expect(reconcileFromDisk({ saved: 'a', draft: 'mine' }, null)).toEqual({ saved: 'a', draft: 'mine', onDisk: null });
    expect(reconcileFromDisk({ saved: 'a' }, null)).toEqual({});
  });
});
