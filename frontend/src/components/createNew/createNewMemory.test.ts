import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANE_ONE_TIME_PROMPT_OPENING } from '../../../../shared/types/paneChat';
import { firstMessagePrompt, formatSize, isAttachableImage, readImageAttachment, rememberMode, rememberTo, rememberedMode, rememberedTo } from './createNewMemory';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('Create New memory (T-63)', () => {
  it('opens as a Session until Create was switched to a Pane, then as a Pane', () => {
    expect(rememberedMode()).toBe('session');
    rememberMode('pane');
    expect(rememberedMode()).toBe('pane');
    rememberMode('session');
    expect(rememberedMode()).toBe('session');
  });

  it('remembers the last To', () => {
    expect(rememberedTo()).toBeNull();
    rememberTo('profile:greenfield/orchestrator');
    expect(rememberedTo()).toBe('profile:greenfield/orchestrator');
  });
});

describe('the first message', () => {
  it('rides as a one-time opening prompt, which a relaunch never sends again', () => {
    expect(firstMessagePrompt('  Fix the build.  ')).toBe(`${PANE_ONE_TIME_PROMPT_OPENING}, with the person's first message from New Session:\n\nFix the build.`);
    expect(firstMessagePrompt('   ')).toBeUndefined();
  });

  it('takes the images a chat takes, read as base64', async () => {
    expect(isAttachableImage({ type: 'image/png' })).toBe(true);
    expect(isAttachableImage({ type: 'application/pdf' })).toBe(false);
    const image = await readImageAttachment(new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));
    expect(image).toMatchObject({ name: 'shot.png', size: 3, mimeType: 'image/png', data: 'AQID' });
  });

  it('sizes attachments as people read them', () => {
    expect(formatSize(70)).toBe('70 B');
    expect(formatSize(47 * 1024)).toBe('47 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
