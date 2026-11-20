import { describe, expect, it } from 'vitest';
import { isOlderHost } from './streamClient';

describe('isOlderHost', () => {
  it('reads an older host from what each connection says about a command it lacks', () => {
    // The desktop's connection rewrites the host's refusal (remotePaneClient hostOutdatedError).
    expect(isOlderHost(new Error('parsa-devbox runs an older Pane that does not have this command (browser:frame). Nothing was changed.'))).toBe(true);
    // The host's own answer (PaneCommandRegistry.invoke).
    expect(isOlderHost(new Error('No Pane daemon command registered for channel "browser:frame". This Pane does not have that command.'))).toBe(true);
    expect(isOlderHost(new Error('The host response was incomplete.'))).toBe(false);
  });
});
