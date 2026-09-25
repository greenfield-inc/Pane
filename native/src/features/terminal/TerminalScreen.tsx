import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useEffectEvent, useState, type Dispatch, type SetStateAction } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ToolPanel } from '@shared/types/panels';
import type { RemotePwaAffordances } from '@shared/types/remoteDaemon';

import { useDaemon, useInvokeMutation, useInvokeQuery } from '@/daemon';
import { useTheme } from '@/theme';
import { EmptyState, ErrorState, Icon, Text } from '@/ui';

import { useMarkPaneSeen } from '../panes/hooks';
import { useVoiceDictation } from '../voice/useVoiceDictation';
import { pickPanel, terminalPanels } from './panels';
import { PanelTabs } from './PanelTabs';
import { QuickKeys } from './QuickKeys';
import { ScrollJoystick } from './ScrollJoystick';
import { ShortcutsPanel } from './ShortcutsPanel';
import { TerminalInputBar } from './TerminalInputBar';
import { TerminalTopBar } from './TerminalTopBar';
import { TerminalTouchSurface } from './TerminalTouchSurface';
import { TerminalWebView } from './TerminalWebView';
import { useTerminal } from './useTerminal';

const PANEL_EVENTS = ['panel:created', 'panel:updated', 'panel:deleted', 'panel:activeChanged'];

/**
 * A pane's terminals, laid out like the web app on a phone: the host bar and
 * tabs on top, xterm in the middle, the input and its keys below.
 */
export function TerminalScreen() {
  const { paneId, panelId } = useLocalSearchParams<{ paneId: string; panelId?: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const { client, profile } = useDaemon();
  const queryClient = useQueryClient();

  const pane = useInvokeQuery<{ name: string }>('sessions:get', [paneId]);
  const panelList = useInvokeQuery<ToolPanel[]>('panels:list', [paneId]);
  const hostActive = useInvokeQuery<ToolPanel | null>('panels:getActive', [paneId]);
  const affordances = useInvokeQuery<RemotePwaAffordances>('remote:pwa-affordances', [], { staleTime: 5 * 60_000 });
  const setActive = useInvokeMutation<[string, string]>('panels:set-active');

  // Tabs opened, closed or switched on the desktop show up here too.
  useEffect(() => client.onEvent(event => {
    if (event.type !== 'daemon-event' || !PANEL_EVENTS.includes(event.payload.channel)) return;
    const payload = event.payload.args[0] as { sessionId?: string } | undefined;
    if (payload?.sessionId !== paneId) return;
    void queryClient.invalidateQueries({ queryKey: [profile.id, 'panels:list', paneId] });
    void queryClient.invalidateQueries({ queryKey: [profile.id, 'panels:getActive', paneId] });
  }), [client, paneId, profile.id, queryClient]);

  // Watching a pane counts as seeing it: clear its Ready badge on the way in
  // and out, however the screen was opened (list, notification or link).
  const markSeen = useMarkPaneSeen();
  const markThisPaneSeen = useEffectEvent(() => markSeen(paneId));
  useEffect(() => {
    markThisPaneSeen();
    return () => markThisPaneSeen();
  }, [paneId]);

  const panels = terminalPanels(panelList.data ?? []);
  const panel = pickPanel(panels, panelId ?? null, hostActive.data?.id);

  const [draft, setDraft] = useState('');
  const voice = useVoiceDictation(text => setDraft(current => (current ? `${current} ${text}` : text)));

  const selectPanel = (next: ToolPanel) => {
    router.setParams({ panelId: next.id });
    setActive.mutate([paneId, next.id]);
  };

  return (
    <KeyboardAvoidingView
      testID="pane-detail-screen"
      behavior="padding"
      style={[styles.fill, { backgroundColor: theme.colors.surface }]}
    >
      <TerminalTopBar paneName={pane.data?.name ?? ''} />
      <PanelTabs
        panels={panels}
        selectedId={panel?.id ?? null}
        onSelect={selectPanel}
        onAdd={() => router.push({ pathname: '/pane/[paneId]/new-panel', params: { paneId } })}
      />
      {panel ? (
        <TerminalPanel
          key={panel.id}
          panel={panel}
          draft={draft}
          onChangeDraft={setDraft}
          voice={voice}
          shortcuts={affordances.data?.terminalShortcuts ?? []}
          shortcutsLoading={affordances.isPending}
          onOpenShortcuts={() => void affordances.refetch()}
        />
      ) : (
        <View style={[styles.fill, { backgroundColor: theme.terminal.background }]}>
          {panelList.isPending ? (
            <View style={styles.center}><ActivityIndicator color={theme.colors.textMuted} /></View>
          ) : panelList.isError ? (
            <ErrorState error={panelList.error} onRetry={() => void panelList.refetch()} />
          ) : (
            <EmptyState
              testID="terminal-empty"
              title="No terminals"
              message="This pane has no terminal open. Tap + to start one."
            />
          )}
        </View>
      )}
      <View style={{ height: keyboardVisible ? 0 : insets.bottom }} />
    </KeyboardAvoidingView>
  );
}

function TerminalPanel({ panel, draft, onChangeDraft, voice, shortcuts, shortcutsLoading, onOpenShortcuts }: {
  panel: ToolPanel;
  draft: string;
  onChangeDraft: Dispatch<SetStateAction<string>>;
  voice: ReturnType<typeof useVoiceDictation>;
  shortcuts: RemotePwaAffordances['terminalShortcuts'];
  shortcutsLoading: boolean;
  onOpenShortcuts: () => void;
}) {
  const theme = useTheme();
  const terminal = useTerminal(panel.id, panel.sessionId);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const disabled = terminal.status !== 'ready';

  const sendKey = (data: string) => {
    terminal.scrollToBottom();
    void terminal.sendInput(data).catch(() => undefined);
  };
  const submit = () => {
    const text = draft;
    onChangeDraft('');
    terminal.scrollToBottom();
    void terminal.sendInput(`${text}\r`).catch(() => onChangeDraft(text));
  };
  const insertText = (text: string) => {
    onChangeDraft(current => current + text);
    setClipboardError(null);
    voice.clearError();
  };
  const paste = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) insertText(text);
      else setClipboardError('Clipboard is empty or unavailable.');
    } catch {
      setClipboardError('Clipboard access is unavailable. Paste into the input instead.');
    }
  };
  const toggleShortcuts = () => {
    if (!showShortcuts) onOpenShortcuts();
    setShowShortcuts(!showShortcuts);
  };

  return (
    <>
      <View style={[styles.fill, { backgroundColor: theme.terminal.background }]}>
        <View style={styles.screen}>
          <TerminalTouchSurface rows={terminal.rows} onScrollLines={terminal.scrollLines}>
            <TerminalWebView
              ref={terminal.webView}
              onMessage={terminal.onMessage}
              screenText={terminal.screenText}
              onProcessGone={terminal.reload}
            />
          </TerminalTouchSurface>
        </View>
        {terminal.status !== 'ready' ? (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: theme.terminal.background }]}>
            {terminal.status === 'loading' ? (
              <ActivityIndicator testID="terminal-loading" color={theme.colors.textMuted} />
            ) : (
              <ErrorState title="Terminal unavailable" error={terminal.error} onRetry={terminal.retry} testID="terminal-error" />
            )}
          </View>
        ) : null}
        {terminal.status === 'ready' ? (
          <View style={styles.joystick} pointerEvents="box-none">
            <ScrollJoystick onScroll={terminal.scrollLines} />
          </View>
        ) : null}
        {terminal.status === 'ready' && !terminal.atBottom ? (
          <Pressable
            testID="terminal-scroll-bottom"
            accessibilityRole="button"
            accessibilityLabel="Scroll to bottom"
            onPress={terminal.scrollToBottom}
            style={[styles.toBottom, { borderRadius: theme.radius.md, backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
          >
            <Icon ios="arrow.down" android="arrow_downward" size={14} color={theme.colors.textSecondary} />
            <Text variant="callout" tone="secondary">Latest</Text>
          </Pressable>
        ) : null}
        {showShortcuts ? (
          <ShortcutsPanel
            shortcuts={shortcuts}
            loading={shortcutsLoading}
            onPick={text => {
              insertText(text);
              setShowShortcuts(false);
            }}
            onClose={() => setShowShortcuts(false)}
          />
        ) : null}
      </View>
      <View style={[styles.inputArea, { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border }]}>
        <TerminalInputBar
          draft={draft}
          onChangeDraft={onChangeDraft}
          onSubmit={submit}
          voice={voice}
          disabled={disabled}
        />
        <QuickKeys
          onKey={sendKey}
          onPaste={() => void paste()}
          onReset={() => {
            terminal.scrollToBottom();
            void terminal.clearScrollback().catch(() => undefined);
          }}
          shortcutsOpen={showShortcuts}
          onToggleShortcuts={toggleShortcuts}
          disabled={disabled}
        />
        {clipboardError ? <Text variant="footnote" tone="danger">{clipboardError}</Text> : null}
        {voice.error ? (
          <Pressable testID="voice-error" onPress={voice.clearError} accessibilityHint="Dismiss">
            <Text variant="footnote" tone="danger">{voice.error}</Text>
          </Pressable>
        ) : null}
      </View>
    </>
  );
}

function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // The web app insets xterm 8 pt from the sides and top.
  screen: { flex: 1, paddingHorizontal: 8, paddingTop: 8 },
  joystick: { position: 'absolute', right: 8, top: 0, bottom: 0, justifyContent: 'center' },
  toBottom: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    height: 36,
    borderWidth: 1,
  },
  inputArea: { borderTopWidth: 1, padding: 12, gap: 8 },
});
