import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { decisionModel } from '../../../../shared/autopilotDecision';

const base = (extra: Partial<NotifyItem>): NotifyItem => ({
  id: 'n1', ui: 'approve', title: 'Q-14 Approve the chat tabs plan (r7)?', state: 'waiting', createdAt: 0,
  source: { name: 'planner', agent: 'Claude', session: { id: 's1', name: 'Pane Fixes', paneId: 'o1', orchestrator: true } },
  ...extra,
});

describe('decisionModel: one decision card for desktop and phone', () => {
  it('splits the Q-n from the title and names the kind, Session and who asked', () => {
    const model = decisionModel(base({ context: 'Six packages, about 7½ weeks.' }));
    expect(model).toMatchObject({ kind: 'Approval', qn: 'Q-14', title: 'Approve the chat tabs plan (r7)?', session: 'Pane Fixes', who: 'orchestrator', why: 'Six packages, about 7½ weeks.', contextLabel: 'More context' });
  });

  it('keeps a range or list of Q-n together in the chip, never half in the title', () => {
    const cases: Array<[string, string, string]> = [
      ["Q-1–3: Where's the status page?", 'Q-1–3', "Where's the status page?"],
      ['Q-4-6 Pick the export format', 'Q-4-6', 'Pick the export format'],
      ['Q-7, Q-8: Two small calls', 'Q-7, Q-8', 'Two small calls'],
      ['Q-9 - 3 tests fail on main', 'Q-9', '3 tests fail on main'],
    ];
    for (const [title, qn, rest] of cases) expect(decisionModel(base({ title }))).toMatchObject({ qn, title: rest });
  });

  it('gives an approval two options, Approve recommended first', () => {
    const { options } = decisionModel(base({}));
    expect(options.map(option => [option.label, option.recommended, option.answer])).toEqual([
      ['Approve', true, { approved: true }],
      ['Deny', false, { approved: false }],
    ]);
  });

  it('lists a question\'s choices with the recommended one first, keeping each detail', () => {
    const { options, kind } = decisionModel(base({ ui: 'options', title: 'Q-5: Sidebar order?', choices: [
      { label: 'Created, newest first', detail: 'Stable, but busy Sessions sink' },
      { label: 'Last activity', detail: 'A Session moves up when something happens in it', recommended: true },
    ] }));
    expect(kind).toBe('Question');
    expect(options.map(option => [option.label, option.recommended, option.detail])).toEqual([
      ['Last activity', true, 'A Session moves up when something happens in it'],
      ['Created, newest first', false, 'Stable, but busy Sessions sink'],
    ]);
    expect(options[0].answer).toEqual({ choice: 'Last activity' });
  });

  it('marks Autopilot\'s own item, with "Why I\'m asking" for its context', () => {
    const model = decisionModel(base({ source: { name: 'Autopilot', agent: 'Claude', autopilot: true }, title: 'Close out finished work in Pane Fixes?' }));
    expect(model).toMatchObject({ kind: 'Autopilot', byAutopilot: true, contextLabel: "Why I'm asking", who: 'Autopilot' });
    expect(model.qn).toBeUndefined();
  });

  it('takes a typed answer for an open question, with its suggestions as options', () => {
    const model = decisionModel(base({ ui: 'ask', title: 'What should the release be called?', suggestions: ['Autumn', 'v3'] }));
    expect(model.freeText).toBe(true);
    expect(model.options.map(option => option.answer)).toEqual([{ text: 'Autumn' }, { text: 'v3' }]);
  });

  it('keeps a permission prompt\'s own Yes and No', () => {
    const model = decisionModel(base({ ui: 'options', title: 'Run terraform apply?', agentPrompt: { yes: 'Yes', no: 'No' }, choices: [{ label: 'Yes' }, { label: 'No' }] }));
    expect(model.kind).toBe('Permission');
    expect(model.options.map(option => option.label)).toEqual(['Yes', 'No']);
  });

  it('names a worker by its Pane, and takes no answer for a prompt only its terminal can answer now', () => {
    const worker = decisionModel(base({ source: { name: 'infra-queue', agent: 'Claude', session: { id: 's2', name: 'Infra', paneId: 'o2' } } }));
    expect(worker.who).toBe('infra-queue');
    const inTerminal = decisionModel(base({ ui: 'options', agentPrompt: { yes: 'Yes', no: 'No', inTerminal: true }, choices: [{ label: 'Yes' }, { label: 'No' }] }));
    expect(inTerminal.answerable).toBe(false);
  });
});
