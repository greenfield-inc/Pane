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
  const shared: NotifySharedState = { machine: 'Work Mac', epoch: 'e1', revision: 1, enabled: true, queue: ['q-secret'], hidden: [], items: [secret] };
  return { shared, command: { isPending: false, isError: false, mutate: () => undefined } };
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
