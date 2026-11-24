import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { resolveApprovalLink } from './approvalLink';

const doozy = { id: 's1', name: 'Doozy', paneId: 'sp' };
const grain = { id: 's2', name: 'Firecracker Grain', paneId: 'sp2' };

function card(id: string, title: string, extra: Partial<NotifyItem> = {}): NotifyItem {
  return {
    id, ui: 'options', title, choices: [{ label: 'Yes' }, { label: 'No' }],
    source: { name: 'orchestrator', agent: 'Claude', paneId: doozy.paneId, panelId: 'orch', session: doozy },
    connected: { kind: 'session', id: doozy.id, name: doozy.name, paneId: doozy.paneId },
    state: 'waiting', createdAt: 1, ...extra,
  };
}

const inGrain: Partial<NotifyItem> = {
  source: { name: 'orchestrator', agent: 'Claude', paneId: grain.paneId, panelId: 'orch2', session: grain },
  connected: { kind: 'session', id: grain.id, name: grain.name, paneId: grain.paneId },
};
// The MacBook's own Session with the same id shape: a second machine numbers its Q-n too.
const onMacbook: Partial<NotifyItem> = { machineId: 'macbook', machine: 'tylers-macbook-pro' };

describe('resolveApprovalLink', () => {
  const linking = card('q2', 'Q-2: Ship it?', { links: [{ label: 'Q-1', approval: 'Q-1' }] });
  const otherSession = card('grain-q1', 'Q-1: Merge the Grain fix?', inGrain);
  const otherMachine = card('macbook:q1', 'Q-1: Phone-number accounts?', onMacbook);
  const own = card('doozy-q1', 'Q-1: Which database?', { state: 'answered', resolvedAt: 5 });

  it('test 6: a Q-1 link with a Q-1 in two Sessions and on a second machine opens the linking card\'s own', () => {
    expect(resolveApprovalLink([otherSession, otherMachine, own, linking], linking, 'Q-1')).toBe('doozy-q1');
    expect(resolveApprovalLink([otherMachine, otherSession, own, linking], linking, 'Q-1')).toBe('doozy-q1');
  });

  it('a waiting Q-n comes before an ended one with the same label', () => {
    const asked = card('doozy-q1-again', 'Q-1: Which database, now with Postgres?', { createdAt: 9 });
    expect(resolveApprovalLink([own, asked, linking], linking, 'Q-1')).toBe('doozy-q1-again');
  });

  it('no Q-n of its own: nothing, never another Session\'s or machine\'s', () => {
    expect(resolveApprovalLink([otherSession, otherMachine, linking], linking, 'Q-1')).toBeUndefined();
  });

  it('a card on the second machine finds that machine\'s Q-n, not this one\'s', () => {
    const remoteLinking = card('macbook:q2', 'Q-2: Ship it?', { ...onMacbook, links: [{ label: 'Q-1', approval: 'Q-1' }] });
    expect(resolveApprovalLink([own, otherSession, otherMachine, remoteLinking], remoteLinking, 'Q-1')).toBe('macbook:q1');
  });

  it('an id still opens that card, wherever it is', () => {
    expect(resolveApprovalLink([otherSession, linking], linking, 'grain-q1')).toBe('grain-q1');
  });

  it('outside a Session, the Pane it came from is its scope', () => {
    const inPane: Partial<NotifyItem> = { source: { name: 'fix-auth', agent: 'Claude', paneId: 'p1', panelId: 't1' }, connected: { kind: 'pane', id: 'p1', name: 'fix-auth' } };
    const paneLinking = card('p-q2', 'Q-2: Ship it?', { ...inPane, links: [{ label: 'Q-1', approval: 'Q-1' }] });
    const paneQ1 = card('p-q1', 'Q-1: Which branch?', inPane);
    expect(resolveApprovalLink([own, paneQ1, paneLinking], paneLinking, 'Q-1')).toBe('p-q1');
  });
});

describe('resolveApprovalLink: the linking card itself', () => {
  it('a newer Q-1 linking to the Q-1 it replaced opens that one, not itself', () => {
    const before = card('old', 'Q-1: Which database?', { state: 'answered', createdAt: 1 });
    const again = card('new', 'Q-1: Which database, now with Postgres?', { createdAt: 2, links: [{ label: 'The first Q-1', approval: 'Q-1' }] });
    expect(resolveApprovalLink([again, before], again, 'Q-1')).toBe('old');
  });
});
