import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudSandboxSetupWarning } from './CloudSandboxSetupWarning';

function render(githubTokenSet: boolean, localStartScriptSet: boolean): string {
  return renderToStaticMarkup(<CloudSandboxSetupWarning githubTokenSet={githubTokenSet} localStartScriptSet={localStartScriptSet} />);
}

describe('CloudSandboxSetupWarning', () => {
  it('shows nothing once the GitHub token and the local start script are both set', () => {
    expect(render(true, true)).toBe('');
  });

  it('names only the GitHub token when that is the one missing', () => {
    const markup = render(false, true);
    expect(markup).toContain('No GitHub token is set.');
    expect(markup).toContain('Set a GitHub token');
    expect(markup).not.toContain('local start script');
  });

  it('names only the local start script when that is the one missing', () => {
    const markup = render(true, false);
    expect(markup).toContain('No local start script is set.');
    expect(markup).toContain('Set a local start script');
    expect(markup).not.toContain('GitHub token');
  });

  it('names both, and never blocks adding the sandbox', () => {
    const markup = render(false, false);
    expect(markup).toContain('Set a GitHub token');
    expect(markup).toContain('Set a local start script');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('You can still add the sandbox now.');
  });
});
