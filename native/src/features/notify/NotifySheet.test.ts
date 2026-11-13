import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { NotifyItem, NotifySharedState } from '@shared/types/notify';

import { NotifySheet } from './NotifySheet';

// Rendered without a native renderer: hooks hold their first value, and each
// React Native or app primitive stays an element whose props can be read.
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: <T>(initial: T | (() => T)) => [initial instanceof Function ? initial() : initial, () => undefined],
  useEffect: () => undefined,
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View', StyleSheet: { create: <T>(styles: T) => styles } }));
vi.mock('expo-haptics', () => ({ notificationAsync: () => Promise.resolve(), NotificationFeedbackType: { Success: 'success' } }));
vi.mock('expo-router', () => ({ router: { back: () => undefined, push: () => undefined } }));
vi.mock('@/auth/hostsStore', () => ({ useHostsStore: (select: (state: { profiles: [] }) => unknown) => select({ profiles: [] }) }));
vi.mock('@/daemon', () => ({ useDaemon: () => ({ profile: { id: 'host-1' } }) }));
vi.mock('@/features/panes/PaneKit', () => ({ DialogSection: 'DialogSection', DialogSheet: 'DialogSheet', Notice: 'Notice', SheetButton: 'SheetButton' }));
vi.mock('@/theme', () => ({ monoFontFamily: 'Menlo', useTheme: () => ({ radius: { lg: 12 }, colors: {} }) }));
vi.mock('@/ui', () => ({ Icon: 'Icon', Text: 'Text', TextField: 'TextField' }));

const { shared, command } = vi.hoisted(() => {
  const secret: NotifyItem = {
    id: 'q-secret', ui: 'secret', title: 'Stripe test secret key', state: 'waiting', createdAt: 1_000,
    source: { paneId: 'pane-1', name: 'auth-refactor', agent: 'Claude' },
    secret: { project: 'stripe', name: 'STRIPE_SECRET_KEY' },
  };
  const trains: NotifyItem = {
    id: 'q-trains', ui: 'options', title: 'Turn on trains?', state: 'waiting', createdAt: 2_000,
    source: { paneId: 'pane-1', name: 'doozy-overhaul', agent: 'Claude' },
    choices: [{ label: 'Yes, turn it on', was: 'Yes' }, { label: 'No' }],
    version: 2, readyAgain: 3_000,
    revision: { asked: 'Can it be undone?', whatChanged: ['Added an undo step'], by: 'doozy-overhaul', at: 3_000 },
  };
  const both: NotifyItem = {
    id: 'q-both', ui: 'options', title: 'Set up trains', state: 'waiting', createdAt: 2_500,
    source: { paneId: 'pane-1', name: 'doozy-overhaul', agent: 'Claude' },
    questions: [{ title: 'Turn it on?', why: 'Trains cost money while on.', choices: [{ label: 'Yes' }, { label: 'No', recommended: true }] }, { title: 'How many?', choices: [{ label: 'One train' }] }],
    reply: { id: 'r1', text: 'Why one?', at: 2_600, state: 'question', reader: { kind: 'asker', name: 'Doozy' } },
  };
  const shared: NotifySharedState = { machine: 'Work Mac', epoch: 'e1', revision: 1, enabled: true, queue: ['q-secret', 'q-trains', 'q-both'], hidden: [], items: [secret, trains, both] };
  return { shared, command: { isPending: false, isError: false, mutate: vi.fn() } };
});
vi.mock('./hooks', () => ({
  useNotifyShared: () => ({ data: shared, isPending: false, isError: false }),
  useMachineNotifyShared: () => ({ data: undefined, isPending: false, isError: false }),
  useNotifyCommand: () => command,
  useMachineNotifyCommand: () => command,
}));

type Props = Record<string, unknown>;

/** Every host element in the tree, with function components called through. */
function elements(node: ReactNode | unknown, found: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) node.forEach(child => elements(child, found));
  if (!isValidElement<Props>(node)) return found;
  if (typeof node.type === 'function') return elements((node.type as (props: Props) => ReactNode)(node.props), found);
  found.push(node);
  Object.values(node.props).forEach(value => elements(value, found));
  return found;
}

describe('NotifySheet', () => {
  it('asks for a secret in a secure field, and sends a multi-line value to the computer', () => {
    const tree = elements(createElement(NotifySheet, { notifyId: 'q-secret' }));
    const field = tree.find(element => element.props.testID === 'notify-secret');
    expect(field?.type).toBe('TextField');
    expect(field?.props.secureTextEntry).toBe(true);
    expect(field?.props.multiline).toBeUndefined();
    expect(tree.find(element => element.props.testID === 'notify-secret-one-line')?.props.children)
      .toBe('Takes one line. Answer a multi-line value, such as a PEM key, on your computer.');
  });
});

describe('NotifySheet replies (P7)', () => {
  const byId = (tree: ReactElement<Props>[], testID: string) => tree.filter(element => element.props.testID === testID);
  const text = (element: ReactElement<Props> | undefined) => element?.props.children;

  it('shows a revised approval’s What changed and "Updated · ready again", and marks a reworded choice', () => {
    const tree = elements(createElement(NotifySheet, { notifyId: 'q-trains' }));
    expect(text(byId(tree, 'notify-reply-state')[0])).toBe('Updated · ready again');
    expect(text(byId(tree, 'notify-revision-asked')[0])).toBe('You asked: “Can it be undone?”');
    expect(byId(tree, 'notify-revision-line').map(text)).toEqual(['• Added an undo step']);
    expect(tree.some(element => element.props.children === 'Reworded, was “Yes”')).toBe(true);
  });

  it('keeps a tapped choice with nothing typed as today’s choice answer', () => {
    command.mutate.mockClear();
    const tree = elements(createElement(NotifySheet, { notifyId: 'q-trains' }));
    (byId(tree, 'notify-choice-0')[0]?.props.onPress as () => void)();
    expect(command.mutate).toHaveBeenCalledWith([{ type: 'answer', id: 'q-trains', answer: { choice: 'Yes, turn it on' } }]);
  });

  it('shows each of several questions with its choices, and how the last reply was taken', () => {
    const tree = elements(createElement(NotifySheet, { notifyId: 'q-both' }));
    expect(byId(tree, 'notify-question-0')).toHaveLength(1);
    expect(byId(tree, 'notify-question-1')).toHaveLength(1);
    expect(byId(tree, 'notify-choice-0-1')).toHaveLength(1);
    expect(text(byId(tree, 'notify-reply-state')[0])).toBe('Doozy is getting more context');
    expect(text(byId(tree, 'notify-reply-detail')[0])).toBe('You wrote: “Why one?”');
    // Each question's why sits under it; a question without one shows none.
    expect(text(byId(tree, 'notify-question-why-0')[0])).toBe('Trains cost money while on.');
    expect(byId(tree, 'notify-question-why-1')).toHaveLength(0);
    // The first question starts on its recommended choice; the second has none, so Send waits.
    expect(byId(tree, 'notify-choice-0-1')[0]?.props.accessibilityState).toEqual({ selected: true });
    expect(byId(tree, 'notify-choice-0-0')[0]?.props.accessibilityState).toEqual({ selected: false });
    expect(byId(tree, 'notify-send-reply')[0]?.props.disabled).toBe(true);
  });
});
