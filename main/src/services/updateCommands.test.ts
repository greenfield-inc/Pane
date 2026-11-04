import { describe, expect, it } from 'vitest';
import { parseRunpaneArgs } from '../../../packages/runpane/src/commands';
describe('runpane update scope', () => {
  it('defaults to both components and preserves the requested release version', () => {
    expect(parseRunpaneArgs(['update', '--version', '2.4.182'])).toMatchObject({ updateScope: 'both', paneVersion: '2.4.182' });
  });
  it('selects only the CLI and supports durable status without requiring Pane', () => {
    expect(parseRunpaneArgs(['update', '--cli-only', '--pane-dir', '/isolated', '--json'])).toMatchObject({ updateScope: 'cli', paneDir: '/isolated', json: true });
    expect(parseRunpaneArgs(['update', '--status', 'operation-1', '--wait'])).toMatchObject({ updateStatus: 'operation-1', updateWait: true });
  });
  it('rejects conflicting component scopes', () => {
    expect(() => parseRunpaneArgs(['update', '--pane-only', '--cli-only'])).toThrow('mutually exclusive');
  });
});
