import { describe, expect, it } from 'vitest';
import { createMaskOwnership } from './maskOwnership';

describe('createMaskOwnership', () => {
  it('keeps the mask while a newer claim is held, whichever finishes first (F-1)', () => {
    const changes: boolean[] = [];
    const mask = createMaskOwnership(masked => changes.push(masked));
    const releaseRefit = mask.acquire();
    const releaseRefresh = mask.acquire();
    releaseRefit();
    expect(mask.held).toBe(true);
    releaseRefit();
    expect(mask.held).toBe(true);
    releaseRefresh();
    expect(mask.held).toBe(false);
    expect(changes).toEqual([true, false]);
  });
});
