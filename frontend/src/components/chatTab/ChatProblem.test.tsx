import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatProblem } from './ChatProblem';

const exited = { code: 'exited' as const, message: 'The agent exited (code 1).', next: 'Press Restart.', action: 'restart' as const };
const noop = () => undefined;

describe('ChatProblem', () => {
  it('offers Restart by default', () => {
    expect(renderToStaticMarkup(<ChatProblem problem={exited} agent="Claude" busy={false} onRestart={noop} onSignIn={noop} onInstall={noop} />)).toContain('>Restart<');
  });

  it('keeps the reason but leaves restarting to its owner when restart is off (Autopilot\'s Start, review QA)', () => {
    const html = renderToStaticMarkup(<ChatProblem problem={exited} agent="Claude" busy={false} restart={false} onRestart={noop} onSignIn={noop} onInstall={noop} />);
    expect(html).toContain('The agent exited (code 1).');
    expect(html).not.toContain('>Restart<');
    expect(html).not.toContain('>Retry<');
    expect(html).not.toContain('Press Restart.');
    expect(html).toContain('Press Start above to start it again.');
  });
});
