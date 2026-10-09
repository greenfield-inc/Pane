import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useEffectEvent, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { OrchestrationSessionView } from '@shared/types/orchestrationSession';
import type { ToolPanel } from '@shared/types/panels';
import type { RemotePwaAffordances } from '@shared/types/remoteDaemon';

import { useDaemon, useInvokeMutation, useInvokeQuery } from '@/daemon';
import { useTheme } from '@/theme';
import { EmptyState, ErrorState, Icon, Text } from '@/ui';

import { draftKey, readDraft, writeDraft } from '../composer/composerDrafts';
import { insertAtSelection, type Selection } from '../composer/insertText';
import { useAffordances } from '../hosts/hostSettings';
import { clearPaneNotifications } from '../notifications/device';
import { useMarkPaneSeen } from '../panes/hooks';
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
  const queryClient = useQueryClient();

  const pane = useInvokeQuery<{ name: string }>('sessions:get', [paneId], { enabled: !session });
  const panelList = useInvokeQuery<ToolPanel[]>('panels:list', [paneId]);
  // A Session opens on its agent chat, wherever the desktop left the workspace.
  const hostActive = useInvokeQuery<ToolPanel | null>('panels:getActive', [paneId], { enabled: !session });
  const affordances = useAffordances();
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
  const title = session ? session.session.name || 'Untitled' : pane.data?.name ?? '';

  const composer = useComposerDraft(panel ? draftKey(profile.id, paneId, panel.id) : null);
  const { draft, setDraft } = composer;
  const voice = useVoiceDictation(composer.insert);
  const uploads = useUploads(paneId, composer.insert);

  // Stop and Clear scrollback sit in the bars above the open terminal, which owns them.
  const terminalActions = useRef<TerminalActions | null>(null);

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
      <TerminalTopBar paneName={title} onClearScrollback={panel ? () => terminalActions.current?.clearScrollback() : undefined} />
      <PanelTabs
        panels={panels}
        selectedId={panel?.id ?? null}
        onSelect={selectPanel}
        onAdd={() => router.push({ pathname: '/pane/[paneId]/new-panel', params: session ? { paneId, sessionId: session.session.id } : { paneId } })}
        onStop={panel ? () => terminalActions.current?.stop() : undefined}
      />
      {panel ? (
        <TerminalPanel
          key={panel.id}
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
  stop: () => void;
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
  const hostLabel = useDaemon().profile.label;
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
  const disabled = terminal.status !== 'ready';

  const sendKey = (data: string) => {
    terminal.scrollToBottom();
    void terminal.sendInput(data).catch(() => undefined);
  };
  useEffect(() => {
    actions.current = {
      stop: () => sendKey(KEYS.stop),
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
  const submit = () => {
    const text = draft;
    onChangeDraft('');
    terminal.scrollToBottom();
    void terminal.sendInput(`${text}${KEYS.enter}`).catch(() => onChangeDraft(text));
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
        {terminal.status === 'ready' && controllerShown ? (
          <FloatingController onKey={sendKey} onScroll={terminal.scrollLines} layout={controllerLayout(terminalHeight, terminal.rows)} />
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
      </View>
      <View style={[styles.inputArea, { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border }]}>
        {voiceSaved ? (
          <View testID="voice-keys-saved" accessibilityLiveRegion="polite" style={[styles.notice, { borderRadius: theme.radius.lg, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised }]}>
            <Icon ios="checkmark" android="check" size={13} color={theme.colors.success} />
            <Text variant="footnote" style={{ color: theme.colors.success }}>Voice keys saved to {hostLabel}</Text>
          </View>
        ) : null}
        <UploadReceipts receipts={uploads.receipts} onCancel={uploads.cancel} onRetry={uploads.retry} />
        <TerminalInputBar
          draft={draft}
          onChangeDraft={onChangeDraft}
          onSubmit={submit}
          voice={voice}
          onAttach={() => setShowAttach(true)}
          onPaste={() => void paste()}
          onShortcuts={openShortcuts}
          onCopy={() => setShowCopy(true)}
          onSetupVoice={() => setShowVoiceSetup(true)}
          controllerShown={controllerShown}
          onToggleController={() => setControllerShown(!controllerShown)}
          onSelectionChange={composer.onSelectionChange}
          selection={composer.selection}
          disabled={disabled}
        />
        {clipboardError ? <Text variant="footnote" tone="danger">{clipboardError}</Text> : null}
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

function initialDraft(key: string | null): DraftState {
  return { key, text: key ? readDraft(key) : '', cursor: null, moveTo: undefined };
}

interface DraftState {
  /** Where the text is saved; null before a terminal tab is chosen. */
  key: string | null;
  text: string;
  /** Last known cursor; null means the end. */
  cursor: Selection | null;
  /** A cursor move the input should apply once, after an insert. */
  moveTo: Selection | undefined;
}

/**
 * The draft and its cursor, kept together so uploads, dictation, paste and
 * shortcuts land where the person was typing, even when two arrive at once.
 * Each terminal tab has its own draft, kept on the device under `key` until
 * sent, so it survives leaving the pane and restarting the app.
 */
function useComposerDraft(key: string | null) {
  const [state, setState] = useState<DraftState>(() => initialDraft(key));
  // Switching tabs loads that tab's draft.
  if (state.key !== key) setState(initialDraft(key));
  useEffect(() => {
    if (state.key) writeDraft(state.key, state.text);
  }, [state.key, state.text]);
  return {
    draft: state.text,
    selection: state.moveTo,
    setDraft: (next: SetStateAction<string>) => setState(current => {
      const text = typeof next === 'function' ? next(current.text) : next;
      return { ...current, text, cursor: text === '' ? null : current.cursor, moveTo: undefined };
    }),
    onSelectionChange: (cursor: Selection) => setState(current => ({ ...current, cursor, moveTo: undefined })),
    insert: (insert: string) => setState(current => {
      const result = insertAtSelection(current.text, current.cursor, insert);
      const cursor = { start: result.cursor, end: result.cursor };
      return { ...current, text: result.text, cursor, moveTo: cursor };
    }),
  };
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
