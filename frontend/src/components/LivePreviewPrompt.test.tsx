import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LivePreviewToast } from './LivePreviewPrompt';

const noop = () => {};

// Clicking through the toast belongs to the app's QA; this suite has no DOM to dispatch events in.
describe('Live preview toast', () => {
  it('asks to open a preview of the port', () => {
    const markup = renderToStaticMarkup(<LivePreviewToast port={5173} failure={null} opening={false} onOpen={noop} onNotNow={noop} />);

    expect(markup).toContain('Dev server on :5173');
    expect(markup).toContain('Open a live preview next to this agent?');
    expect(markup).toContain('Not now');
    expect(markup).toContain('Open preview');
  });

  it("says the preview didn't open, why, and what to do next", () => {
    const markup = renderToStaticMarkup(
      <LivePreviewToast port={5173} failure="Pane pane-x is archived; panels cannot be opened in it" opening={false} onOpen={noop} onNotNow={noop} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Preview didn&#x27;t open');
    expect(markup).toContain('Pane pane-x is archived; panels cannot be opened in it');
    expect(markup).toContain('Try again, or pick :5173 from the + menu.');
    expect(markup).toContain('Try again');
    expect(markup).not.toContain('Open preview');
  });
});
