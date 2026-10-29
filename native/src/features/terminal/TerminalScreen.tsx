import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useEffectEvent, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RemoteUnconfirmedResultError } from '@shared/remoteClient';
import type { OrchestrationSessionView } from '@shared/types/orchestrationSession';
import type { TerminalPanelState, ToolPanel } from '@shared/types/panels';
import type { RemotePwaAffordances } from '@shared/types/remoteDaemon';

import { useDaemon, useInvokeMutation, useInvokeQuery } from '@/daemon';
import { useTheme } from '@/theme';
import { EmptyState, ErrorState, Icon, Text } from '@/ui';

import { AgentConversationSurface } from '../agentChat/AgentConversationSurface';
import { isDemoProfile } from '../demo/demoHost';
import { explainDemoLimit } from '../demo/explainDemoLimit';
import { draftKey } from '../composer/composerDrafts';
import { useComposerDraft } from '../composer/useComposerDraft';
import { Dimmed } from '../hosts/ConnectionStatus';
import { useAffordances } from '../hosts/hostSettings';
import { useConnectionPresence } from '../hosts/useConnectionPresence';
import { clearPaneNotifications } from '../notifications/device';
import { useAgentStatuses, useMarkPaneSeen } from '../panes/hooks';
import { ShortcutsSheet } from '../shortcuts/ShortcutsSheet';
import { AttachSheet } from '../upload/AttachSheet';
import { UploadReceipts } from '../upload/UploadReceipts';
import { useUploads } from '../upload/useUploads';
import { useVoiceDictation } from '../voice/useVoiceDictation';
import { VoiceSetupSheet } from '../voice/VoiceSetupSheet';
import { CopySheet } from './CopySheet';
import { controllerLayout } from './controllerLayout';
import { useControllerShown } from './controllerPreference';
import { FloatingController } from './FloatingController';
import { KEYS } from './keys';
import { pickPanel, sessionWorkspacePanels, terminalPanels } from './panels';
import { PanelTabs } from './PanelTabs';
import { TerminalInputBar } from './TerminalInputBar';
import { TerminalTopBar } from './TerminalTopBar';
import { TerminalTouchSurface } from './TerminalTouchSurface';
import { TerminalWebView } from './TerminalWebView';
import { useTerminal } from './useTerminal';

/** Space between the box and the keyboard while it is up. */
const KEYBOARD_GAP = 8;
/** How long "Voice keys saved" stays above the box. */
const NOTICE_MS = 4000;
const PANEL_EVENTS = ['panel:created', 'panel:updated', 'panel:deleted', 'panel:activeChanged'];

/**
 * A pane's terminals, laid out like the web app on a phone: the host bar and
 * tabs on top, xterm in the middle, the composer box below. With a
 * `session`, it shows that Session's workspace pane, its agent chat first.
 */
export function TerminalScreen({ paneId, session }: { paneId: string; session?: OrchestrationSessionView }) {
  const { panelId } = useLocalSearchParams<{ panelId?: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const { client, profile } = useDaemon();
  const { presence } = useConnectionPresence();
  const queryClient = useQueryClient();

  const pane = useInvokeQuery<{ name: string }>('sessions:get', [paneId], { enabled: !session });
  const panelList = useInvokeQuery<ToolPanel[]>('panels:list', [paneId]);
  // A Session opens on its agent chat, wherever the desktop left the workspace.
  const hostActive = useInvokeQuery<ToolPanel | null>('panels:getActive', [paneId], { enabled: !session });
  const affordances = useAffordances();
  const setActive = useInvokeMutation<[string, string]>('panels:set-active');
  const deletePanel = useInvokeMutation<[string]>('panels:delete', { invalidates: ['panels:list', 'panels:getActive'] });
  const statuses = useAgentStatuses();

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
  const markThisPaneSeen = useEffectEvent(() => {
    markSeen(paneId);
    void clearPaneNotifications(paneId);
  });
  useEffect(() => {
    markThisPaneSeen();
    return () => markThisPaneSeen();
  }, [paneId]);

  const panes = terminalPanels(panelList.data ?? []);
  const panels = session ? sessionWorkspacePanels(session, panes) : panes;
  const panel = pickPanel(panels, panelId ?? null, hostActive.data?.id);
  const conversation = (panel?.state.customState as TerminalPanelState | undefined)?.agentChat?.conversation;
  const terminalActive = !!panel && (!conversation || (conversation.active === 'terminal' && !conversation.transition));
  const title = session ? session.session.name || 'Untitled' : pane.data?.name ?? '';

  const composer = useComposerDraft(panel ? draftKey(profile.id, paneId, panel.id) : null);
  const { draft, setDraft } = composer;
  const voice = useVoiceDictation(composer.insert);
  const uploads = useUploads(paneId, composer.insert);

  // Clear scrollback sits in the bar above the open terminal, which owns it.
  const terminalActions = useRef<TerminalActions | null>(null);

  const selectPanel = (next: ToolPanel) => {
    router.setParams({ panelId: next.id });
    setActive.mutate([paneId, next.id]);
  };

  // A long press on a tab offers Close; a tab whose agent is still at work asks once more.
  const closePanel = (tab: ToolPanel) => {
    const close = () => deletePanel.mutate([tab.id], { onError: error => Alert.alert('Couldn’t close the tab', error.message) });
    const state = statuses.data?.agentStatus[tab.id];
    const confirm = state === 'working' || state === 'blocked'
      ? () => Alert.alert(`Close “${tab.title}”?`, 'Its agent is still working. Closing the tab stops it.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close', style: 'destructive', onPress: close },
      ])
      : close;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: tab.title, options: ['Close', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
        index => { if (index === 0) confirm(); },
      );
    } else {
      Alert.alert(tab.title, undefined, [{ text: 'Cancel', style: 'cancel' }, { text: 'Close', style: 'destructive', onPress: confirm }]);
    }
  };

  return (
    <KeyboardAvoidingView
      testID="pane-detail-screen"
      behavior="padding"
      style={[styles.fill, { backgroundColor: theme.colors.surface }]}
    >
      <TerminalTopBar paneName={title} onClearScrollback={terminalActive ? () => terminalActions.current?.clearScrollback() : undefined} />
      <PanelTabs
        panels={panels}
        selectedId={panel?.id ?? null}
        onSelect={selectPanel}
        onAdd={() => router.push({ pathname: '/pane/[paneId]/new-panel', params: session ? { paneId, sessionId: session.session.id } : { paneId } })}
        onClose={closePanel}
      />
      {panel ? (
        <AgentConversationSurface key={panel.id} panel={panel} draft={draft} onChangeDraft={setDraft} confirmDraft={composer.confirmDelivery}>
        <TerminalPanel
          panel={panel}
          actions={terminalActions}
          draft={draft}
          onChangeDraft={setDraft}
          composer={composer}
          uploads={uploads}
          voice={voice}
          shortcuts={affordances.data?.terminalShortcuts ?? []}
          shortcutsLoading={affordances.isPending}
          // Older hosts send no change events, so read the list fresh each time.
          onOpenShortcuts={() => void affordances.refetch()}
        />
        </AgentConversationSurface>
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
      {/* The box sits on the bottom safe area (HIG: controls stay out of it), or a hair above the keyboard. */}
      <View style={{ height: keyboardVisible ? KEYBOARD_GAP : insets.bottom }} />
    </KeyboardAvoidingView>
  );
}

interface TerminalActions {
  clearScrollback: () => void;
}

function TerminalPanel({ panel, actions, draft, onChangeDraft, composer, uploads, voice, shortcuts, shortcutsLoading, onOpenShortcuts }: {
  panel: ToolPanel;
  /** Filled with this terminal's Stop and Clear scrollback while it is open. */
  actions: RefObject<TerminalActions | null>;
  draft: string;
  onChangeDraft: Dispatch<SetStateAction<string>>;
  composer: ReturnType<typeof useComposerDraft>;
  uploads: ReturnType<typeof useUploads>;
  voice: ReturnType<typeof useVoiceDictation>;
  shortcuts: RemotePwaAffordances['terminalShortcuts'];
  shortcutsLoading: boolean;
  onOpenShortcuts: () => void;
}) {
  const theme = useTheme();
  const { profile } = useDaemon();
  const { presence } = useConnectionPresence();
  const terminal = useTerminal(panel.id, panel.sessionId);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
  const [showVoiceSetup, setShowVoiceSetup] = useState(false);
  const [controllerShown, setControllerShown] = useControllerShown();
  const [terminalHeight, setTerminalHeight] = useState(0);
  const [voiceSaved, setVoiceSaved] = useState(false);
  useEffect(() => {
    if (!voiceSaved) return;
    const timer = setTimeout(() => setVoiceSaved(false), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [voiceSaved]);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Input waits for a live terminal; until then its last screen stays up, dimmed.
  const disabled = terminal.status !== 'ready' || presence !== 'connected';
  const shown = terminal.status === 'ready' || terminal.hasContent;

  const sendKey = (data: string) => {
    terminal.scrollToBottom();
    void terminal.sendInput(data).catch(() => undefined);
  };
  useEffect(() => {
    actions.current = {
      clearScrollback: () => {
        terminal.scrollToBottom();
        void terminal.clearScrollback().catch(() => undefined);
      },
    };
    return () => {
      actions.current = null;
    };
  });
  // An empty box sends a bare Enter, to answer a menu or confirm a prompt.
  // Sending closes the keyboard so the output shows.
  const submit = () => {
    const text = draft;
    onChangeDraft('');
    setSendError(null);
    Keyboard.dismiss();
    terminal.scrollToBottom();
    // The client resends through a drop, so a failure here is final. Say whether it may have landed.
    void terminal.sendInput(`${text}${KEYS.enter}`).catch((error: unknown) => {
      onChangeDraft(text);
      setSendError(error instanceof RemoteUnconfirmedResultError
        ? 'Not confirmed: this may have reached the terminal. Check it before sending again.'
        : 'Not sent. Your text is back in the box; send it again when connected.');
    });
  };
  const insertText = (text: string) => {
    composer.insert(text);
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
  const openShortcuts = () => {
    onOpenShortcuts();
    setShowShortcuts(true);
  };

  return (
    <>
      <View style={[styles.fill, { backgroundColor: theme.terminal.background }]} onLayout={event => setTerminalHeight(event.nativeEvent.layout.height)}>
        <Dimmed dimmed={disabled} style={styles.fill}>
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
          {shown && controllerShown ? (
            <FloatingController onKey={sendKey} onScroll={terminal.scrollLines} layout={controllerLayout(terminalHeight, terminal.rows)} />
          ) : null}
          {shown && !terminal.atBottom ? (
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
        </Dimmed>
        {/* Only a failure while connected replaces the screen; a spinner only covers a blank one. */}
        {terminal.status === 'error' || (terminal.status === 'loading' && !terminal.hasContent) ? (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: theme.terminal.background }]}>
            {terminal.status === 'loading' ? (
              <ActivityIndicator testID="terminal-loading" color={theme.colors.textMuted} />
            ) : (
              <ErrorState title="Terminal unavailable" error={terminal.error} onRetry={terminal.retry} testID="terminal-error" />
            )}
          </View>
        ) : null}
      </View>
      <View style={[styles.inputArea, { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border }]}>
        {voiceSaved ? (
          <View testID="voice-keys-saved" accessibilityLiveRegion="polite" style={[styles.notice, { borderRadius: theme.radius.lg, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised }]}>
            <Icon ios="checkmark" android="check" size={13} color={theme.colors.success} />
            <Text variant="footnote" style={{ color: theme.colors.success }}>Voice keys saved to {profile.label}</Text>
          </View>
        ) : null}
        <UploadReceipts receipts={uploads.receipts} onCancel={uploads.cancel} onRetry={uploads.retry} />
        <TerminalInputBar
          draft={draft}
          onChangeDraft={onChangeDraft}
          onSubmit={submit}
          voice={voice}
          onAttach={() => (isDemoProfile(profile) ? explainDemoLimit('Sending files') : setShowAttach(true))}
          onPaste={() => void paste()}
          onShortcuts={openShortcuts}
          onCopy={() => setShowCopy(true)}
          onSetupVoice={() => (isDemoProfile(profile) ? explainDemoLimit('Voice') : setShowVoiceSetup(true))}
          controllerShown={controllerShown}
          onToggleController={() => setControllerShown(!controllerShown)}
          onSelectionChange={composer.onSelectionChange}
          selection={composer.selection}
          disabled={disabled}
        />
        {clipboardError ? <Text variant="footnote" tone="danger">{clipboardError}</Text> : null}
        {sendError ? (
          <Pressable testID="send-error" onPress={() => setSendError(null)} accessibilityHint="Dismiss">
            <Text variant="footnote" tone="danger">{sendError}</Text>
          </Pressable>
        ) : null}
        {uploads.pickError ? (
          <Pressable testID="upload-pick-error" onPress={uploads.clearPickError} accessibilityHint="Dismiss">
            <Text variant="footnote" tone="danger">{uploads.pickError}</Text>
          </Pressable>
        ) : null}
        {voice.error ? (
          <Pressable testID="voice-error" onPress={voice.clearError} accessibilityHint="Dismiss">
            <Text variant="footnote" tone="danger">{voice.error}</Text>
          </Pressable>
        ) : null}
      </View>
      <AttachSheet visible={showAttach} onClose={() => setShowAttach(false)} onPick={source => void uploads.attach(source)} />
      <ShortcutsSheet
        visible={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        shortcuts={shortcuts}
        loading={shortcutsLoading}
        onPick={insertText}
      />
      <VoiceSetupSheet
        visible={showVoiceSetup}
        onClose={() => setShowVoiceSetup(false)}
        voice={voice}
        onStarted={saved => {
          setShowVoiceSetup(false);
          setVoiceSaved(saved);
        }}
      />
      <CopySheet visible={showCopy} onClose={() => setShowCopy(false)} panelId={panel.id} screenText={terminal.screenText} />
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
  notice: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1 },
  inputArea: { borderTopWidth: 1, paddingHorizontal: 12, paddingTop: 6, gap: 6 },
});
