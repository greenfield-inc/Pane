import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NotifyItem } from '../../../../shared/types/notify';
import { AutopilotDecisionCard } from './AutopilotDecisionCard';

const worker: NotifyItem = {
  id: 'q1', ui: 'ask', title: 'Q-39: run the script?', state: 'waiting', createdAt: Date.now(), machine: 'Mac mini', machineId: 'mini',
  source: { paneId: 'p', panelId: 't', name: 'workos-sso', agent: 'Claude', session: { id: 's', name: 'Sales Skill', paneId: 'sp' } },
};
const render = (item: NotifyItem) => renderToStaticMarkup(<AutopilotDecisionCard item={item} current />);
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

describe('AutopilotDecisionCard', () => {
  it("shows a worker's question with its origin, an answer box and a Close", () => {
    const markup = render(worker);
    expect(text(markup)).toContain('workos-sso in Sales Skill · Mac mini');
    expect(markup).toContain('placeholder="Type your answer"');
    expect(markup).toContain('data-testid="autopilot-decision-close"');
  });

  it('never shows a Close on a permission prompt', () => {
    expect(render({ ...worker, ui: 'options', choices: [{ label: 'Yes' }], agentPrompt: { yes: 'Yes', no: 'No' } })).not.toContain('data-testid="autopilot-decision-close"');
  });

  it("shows an older machine's mirror read-only, and never the old words", () => {
    const visible = text(render({ ...worker, relay: { inboxItemId: 'i', worker: 'api-fix', question: 'q' } }));
    expect(visible).toContain('Read-only: Mac mini runs an older Pane. Answer there.');
    expect(visible).not.toMatch(/stuck|picked this up/i);
  });

  it('says a prompt only its terminal can answer is in its terminal', () => {
    expect(text(render({ ...worker, ui: 'options', choices: [{ label: 'Yes' }], agentPrompt: { yes: 'Yes', no: 'No', inTerminal: true } }))).toContain('Claude is asking in the terminal now.');
  });

  it("shows an Autopilot answer's receipt and an Override, and the decision it became", () => {
    const answered: NotifyItem = { ...worker, state: 'answered', answerSummary: 'Yes', answeredBy: { by: 'autopilot', because: 'D-22' }, decision: 'D-147', delivered: { via: 'tab', at: 2 } };
    const markup = render(answered);
    expect(text(markup)).toContain('Yes · Answered by Autopilot · because D-22 · Recorded as D-147');
    expect(markup).toContain('data-testid="autopilot-decision-override"');
    expect(render({ ...answered, answeredBy: { by: 'you' } })).not.toContain('data-testid="autopilot-decision-override"');
  });

  it('shows why an item closed and a Reopen when it takes one', () => {
    const closed: NotifyItem = { ...worker, state: 'expired', closed: { by: 'autopilot', reason: 'stale', at: 1 } };
    expect(text(render(closed))).toContain('Closed by Autopilot: stale');
    expect(render(closed)).toContain('data-testid="autopilot-decision-reopen"');
    expect(render({ ...closed, closed: { by: 'pane', reason: 'Session archived', at: 1 } })).not.toContain('data-testid="autopilot-decision-reopen"');
  });

  it('shows the rewrite on the new card', () => {
    expect(text(render({ ...worker, rewrittenFrom: { id: 'o', title: 'x', qn: 'Q-3' } }))).toContain('Rewritten by Autopilot from Q-3');
  });
});
