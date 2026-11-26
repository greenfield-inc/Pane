import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, Stack, useIsFocused, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useEffectEvent, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { Alert, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PaneError } from '@shared/paneError';
import { RemoteUnconfirmedResultError } from '@shared/remoteClient';
import type { OrchestrationSessionView } from '@shared/types/orchestrationSession';
import { pausedMarkOf, type BrowserPanelState, type EditorPanelState, type TerminalPanelState, type ToolPanel } from '@shared/types/panels';
import { offersViewLive, streamChoices, viewLive } from '@shared/utils/streamChoice';
import type { RemotePwaAffordances } from '@shared/types/remoteDaemon';

import { useDaemon, useInvokeMutation, useInvokeQuery, useReadOnlyHost } from '@/daemon';
import { useTheme } from '@/theme';
import { EmptyState, ErrorState, Icon, SkeletonSwap, Text } from '@/ui';
import { useAvoidsKeyboard } from '@/features/layout/wideLayout';

import { BrowserTab } from '../browser/BrowserTab';
import { DeviceTab } from '../device/DeviceTab';
import { DiffEditorTab, DiffTab } from '../diff/DiffTab';
import { ExplorerTab } from '../files/ExplorerTab';
import { FileViewer } from '../files/FileViewer';
import { isDemoProfile } from '../demo/demoHost';
import { explainDemoLimit } from '../demo/explainDemoLimit';
import { draftKey } from '../composer/composerDrafts';
import { useComposerDraft } from '../composer/useComposerDraft';
import { perfMark } from '../perf/perfMarks';
import { useJourneyMark, useLiveMarks, useScreenJourney } from '../perf/usePerfMarks';
import { Dimmed } from '../hosts/ConnectionStatus';
import { useAffordances } from '../hosts/hostSettings';
import { useConnectionPresence } from '../hosts/useConnectionPresence';
import { clearPaneNotifications } from '../notifications/device';
import { LogsTab } from '../runScript/LogsTab';
import { useAgentStatuses, useMarkPaneSeen } from '../panes/hooks';
import { ShortcutsSheet } from '../shortcuts/ShortcutsSheet';
import { PlaceholderTab } from '../tabs/PlaceholderTab';
import { ChatTabBody } from '../chatTab/ChatTabBody';
import { LinkPane } from '../links/LinkMenu';
import { AttachSheet } from '../upload/AttachSheet';
import { UploadReceipts } from '../upload/UploadReceipts';
import { useUploads } from '../upload/useUploads';
import { useVoiceDictation } from '../voice/useVoiceDictation';
import { VoiceAudio } from '../voice/VoiceAudio';
import { VoiceSetupSheet } from '../voice/VoiceSetupSheet';
import { CopySheet } from './CopySheet';
import { controllerLayout } from './controllerLayout';
import { useControllerShown } from './controllerPreference';
import { FloatingController } from './FloatingController';
import { KEYS } from './keys';
import { followsHost, pickPanel, sessionWorkspacePanels, stripPanels, tabView } from './panels';
import { offerClose, PanelTabs, type LeadingTab } from './PanelTabs';
import { PausedTerminal } from './PausedTerminal';
import { TerminalInputBar } from './TerminalInputBar';
import { KeptScreen, PanelTabsSkeleton, TerminalSkeleton } from './TerminalSkeletons';
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
 * A pane's tabs, laid out like the web app on a phone: the host bar and tabs
 * on top, then the open tab. A terminal shows xterm with the composer box
 * below; other tabs get a view for their type. With a `session`, it shows
 * that Session's workspace pane, its agent chat first. The approval screen
 * passes its own `topBar` and its own tabs (`leading`), which open first.
 */
export function TerminalScreen({ paneId, session, topBar, leading }: {
  paneId: string;
  session?: OrchestrationSessionView;
  /** Replaces the host bar. */
  topBar?: ReactNode;
  leading?: LeadingTabs;
}) {
  const { panelId } = useLocalSearchParams<{ panelId?: string }>();
  const avoidsKeyboard = useAvoidsKeyboard();
  // This screen's own params: effects below run before the navigator is ready, and while another screen has focus.
  const navigation = useNavigation<{ setParams(params: { panelId: string }): void }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, profile } = useDaemon();
  const readOnly = useReadOnlyHost();
  const { presence } = useConnectionPresence();
  const queryClient = useQueryClient();

  const pane = useInvokeQuery<{ name: string }>('sessions:get', [paneId], { enabled: !session });
  // Chat tabs are listed only for clients that say they understand them.
  const panelList = useInvokeQuery<ToolPanel[]>('panels:list', [paneId, { chatTabs: true, chatAgents: true }]);
  // A Session opens on its agent chat, wherever the desktop left the workspace.
  const hostActive = useInvokeQuery<ToolPanel | null>('panels:getActive', [paneId], { enabled: !session });
  const affordances = useAffordances();
  const setActive = useInvokeMutation<[string, string]>('panels:set-active');
  const deletePanel = useInvokeMutation<[string]>('panels:delete', { invalidates: ['panels:list', 'panels:getActive'] });
  const statuses = useAgentStatuses();
  const resumePanel = useInvokeMutation<[{ panelId: string }]>('runpane:panels:resume', { invalidates: ['panels:list'] });
  const resume = (tab: ToolPanel) => resumePanel.mutate([{ panelId: tab.id }], {
    onError: error => Alert.alert('Couldn’t resume the tab', error.message),
  });

  // Tabs opened, closed or switched on the desktop show up here too. When the
  // host or an agent brings a tab forward, the phone follows if it draws that tab;
  // a tab opened that moment is followed once the refreshed list holds it.
  const [follow, setFollow] = useState<string | null>(null);
  useEffect(() => client.onEvent(event => {
    if (event.type !== 'daemon-event' || !PANEL_EVENTS.includes(event.payload.channel)) return;
    const payload = event.payload.args[0] as { sessionId?: string; panelId?: string } | undefined;
    if (payload?.sessionId !== paneId) return;
    void queryClient.invalidateQueries({ queryKey: [profile.id, 'panels:list', paneId] });
    void queryClient.invalidateQueries({ queryKey: [profile.id, 'panels:getActive', paneId] });
    if (event.payload.channel === 'panel:activeChanged' && payload.panelId) setFollow(payload.panelId);
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
  // An agent that finishes while its Pane is on screen was seen finishing, so Home beside it never marks it Ready.
  const focused = useIsFocused();
  const finishedUnseen = focused && Boolean(statuses.data?.unseen[paneId]);
  useEffect(() => {
    if (finishedUnseen) markSeen(paneId);
  }, [finishedUnseen, paneId]);

  const strip = stripPanels(panelList.data ?? [], readOnly);
  const panels = session ? sessionWorkspacePanels(session, strip) : strip;
  const leadingTab = leading?.tabs.find(tab => tab.id === (panelId ?? leading.tabs[0]?.id));
  const panel = leadingTab ? null : pickPanel(panels, panelId ?? null, hostActive.data?.id);
  const view = panel ? tabView(panel) : null;
  const paused = panel ? pausedMarkOf(panel) : undefined;
  const followed = follow ? panels.find(candidate => candidate.id === follow) : undefined;
  useEffect(() => {
    if (!followed) return;
    // Reading the screen's own tab (an approval), the phone stays put.
    if (followsHost(followed) && !leadingTab) navigation.setParams({ panelId: followed.id });
    setFollow(null);
  }, [followed, leadingTab]);
  // The tab on screen stays put until the person or a host announcement moves it,
  // so the host's active tab changing to one the phone doesn't follow never jumps it.
  const shownId = panel?.id;
  const hasLeading = leading !== undefined;
  useEffect(() => {
    if (!panelId && shownId && !hasLeading) navigation.setParams({ panelId: shownId });
  }, [panelId, shownId, hasLeading]);
  const terminalActive = view === 'terminal' && !paused;
  const title = session ? session.session.name || 'Untitled' : pane.data?.name ?? '';

  const composer = useComposerDraft(panel ? draftKey(profile.id, paneId, panel.id) : null);
  const { draft, setDraft } = composer;
  const voice = useVoiceDictation(composer.insert);
  const uploads = useUploads(paneId, composer.insert);

  // Clear scrollback sits in the bar above the open terminal, which owns it.
  const terminalActions = useRef<TerminalActions | null>(null);

  // With the host's resume-on-open setting, a paused tab the person opens resumes. Only the tab
  // shown when the screen opens, or one they pick, counts; a tab paused while on screen stays paused.
  const resumeOnOpen = !readOnly && affordances.data?.resumePausedOnOpen === true;
  const openChecked = useRef(false);
  useEffect(() => {
    if (openChecked.current || (!panel && !leadingTab) || affordances.isPending) return;
    openChecked.current = true;
    // Opening on the screen's own tab, only a picked tab resumes (selectPanel).
    if (panel && resumeOnOpen && pausedMarkOf(panel)) resume(panel);
  });

  const selectPanel = (next: ToolPanel) => {
    navigation.setParams({ panelId: next.id });
    setActive.mutate([paneId, next.id]);
    if (resumeOnOpen && next.id !== panel?.id && pausedMarkOf(next)) resume(next);
  };


  // A long press on a tab offers Close (and View live on a page tab an agent used); a tab whose agent is still at work asks once more.
  const closePanel = (tab: ToolPanel) => {
    const close = () => deletePanel.mutate([tab.id], { onError: error => Alert.alert('Couldn’t close the tab', error.message) });
    const state = statuses.data?.agentStatus[tab.id];
    const confirm = state === 'working' || state === 'blocked'
      ? () => Alert.alert(`Close “${tab.title}”?`, 'Its agent is still working. Closing the tab stops it.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close', style: 'destructive', onPress: close },
      ])
      : close;
    // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
    const page = tab.type === 'browser' ? tab.state.customState as BrowserPanelState | undefined : undefined;
    const live = tab.type === 'browser' && offersViewLive(streamChoices.all().get(tab.id), page) ? () => { viewLive(tab.id, page); selectPanel(tab); } : undefined;
    offerClose(tab.title, confirm, live);
  };

  return (
    <KeyboardAvoidingView
      testID="pane-detail-screen"
      behavior="padding"
      enabled={avoidsKeyboard}
      style={[styles.fill, { backgroundColor: theme.colors.surface }]}
    >
      {/* A watched terminal pans sideways, so swipe-back there starts from the left edge only. */}
      <Stack.Screen options={{ fullScreenGestureEnabled: !(readOnly && terminalActive) }} />
      {/* Dictation's audio, here so a recording survives switching tabs; mounted on first use. */}
      {voice.audio ? <VoiceAudio {...voice.audio} /> : null}
      {topBar ?? <TerminalTopBar paneName={title} onClearScrollback={terminalActive && !readOnly ? () => terminalActions.current?.clearScrollback() : undefined} />}
      {/* An approval's layout is final once the tabs and the tab body stop moving (perf marks). */}
      <View onLayout={({ nativeEvent: { layout } }) => perfMark('approval', `tabs=${Math.round(layout.y)}+${Math.round(layout.height)}`, { changes: true })}>
        {/* Tab lists of recent Panes are kept on the phone, so this skeleton shows only for a Pane never opened here. */}
        <SkeletonSwap loading={!leading && panelList.isPending && panels.length === 0} skeleton={<PanelTabsSkeleton />}>
        <PanelTabs
          panels={panels}
          chatId={session?.panel.id}
          selectedId={leadingTab?.id ?? panel?.id ?? null}
          leading={leading?.tabs}
          onSelectLeading={id => navigation.setParams({ panelId: id })}
          onSelect={selectPanel}
          onAdd={readOnly ? undefined : () => router.push({ pathname: '/pane/[paneId]/new-panel', params: session ? { paneId, sessionId: session.session.id } : { paneId } })}
          onClose={readOnly ? undefined : closePanel}
        />
        </SkeletonSwap>
      </View>
      <View style={styles.fill} onLayout={({ nativeEvent: { layout } }) => perfMark('approval', `body=${Math.round(layout.y)}+${Math.round(layout.height)}`, { changes: true })}>
      {leading ? <LeadingBodies leading={leading} selectedId={leadingTab?.id ?? null} /> : null}
      {leadingTab ? null : (
      <SkeletonSwap loading={panelList.isPending && !panel} skeleton={<TerminalSkeleton testID="pane-skeleton" label="Loading the Pane" />} style={styles.fill}>
      {panel && view !== 'terminal' ? (
        <TabBody panel={panel} title={title} panels={panels} />
      ) : panel && paused ? (
        <PausedTerminal key={panel.id} panelId={panel.id} mark={paused} resuming={resumePanel.isPending} onResume={readOnly ? undefined : () => resume(panel)} />
      ) : panel ? (
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
          {panelList.isError ? (
            <ErrorState error={panelList.error} onRetry={() => void panelList.refetch()} />
          ) : (
            <EmptyState
              testID="terminal-empty"
              title="No tabs"
              message={readOnly ? 'This pane has no terminal or chat tabs open.' : 'This pane has no tabs open. Tap + to start a terminal.'}
            />
          )}
        </View>
      )}
      </SkeletonSwap>
      )}
      </View>
      {/* The box sits on the bottom safe area (HIG: controls stay out of it), or a hair above the keyboard. */}
      <BottomGap />
    </KeyboardAvoidingView>
  );
}

/** A screen's own tabs ahead of the Pane's, picked through the `panelId` route param like the rest; the first opens when none is picked. */
export interface LeadingTabs {
  tabs: readonly LeadingTab[];
  render: (id: string) => ReactNode;
}

/**
 * The bodies of a screen's own tabs. The first stays mounted, hidden while another tab shows, so
 * what was typed or picked there (an approval's answer) survives a look at another tab.
 */
export function LeadingBodies({ leading, selectedId }: { leading: LeadingTabs; selectedId: string | null }) {
  const first = leading.tabs[0];
  const other = leading.tabs.find(tab => tab.id === selectedId && tab !== first);
  return (
    <>
      {first ? <View style={first.id === selectedId ? styles.fill : styles.hidden}>{leading.render(first.id)}</View> : null}
      {other ? <View key={other.id} style={styles.fill}>{leading.render(other.id)}</View> : null}
    </>
  );
}

/** A tab that is not a terminal, drawn by its type; its links open in Pane in the tab's Pane. */
function TabBody({ panel, title, panels }: { panel: ToolPanel; title: string; panels: readonly ToolPanel[] }) {
  return <LinkPane value={panel.sessionId}><TabView panel={panel} title={title} panels={panels} /></LinkPane>;
}

function TabView({ panel, title, panels }: { panel: ToolPanel; title: string; panels: readonly ToolPanel[] }) {
  switch (tabView(panel)) {
    case 'chat':
      return <ChatTabBody panel={panel} panels={panels} />;
    case 'browser':
      return <BrowserTab key={panel.id} panel={panel} />;
    case 'explorer':
      return <ExplorerTab key={panel.id} panel={panel} rootName={title} />;
    case 'diff':
      return <DiffTab panel={panel} />;
    case 'editor':
      return <FileViewer key={panel.id} sessionId={panel.sessionId} path={(panel.state.customState as EditorPanelState).filePath} />;
    case 'file-diff':
      return <DiffEditorTab key={panel.id} panel={panel} />;
    case 'logs':
      return <LogsTab key={panel.id} panel={panel} />;
    case 'device':
      return <DeviceTab key={panel.id} panel={panel} panels={panels} />;
    default:
      return <PlaceholderTab panel={panel} />;
  }
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
  useScreenJourney('terminal', panel.id);
  const { profile } = useDaemon();
  const readOnly = useReadOnlyHost();
  const { live } = useConnectionPresence();
  const terminal = useTerminal(panel.id, panel.sessionId);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
  const [showVoiceSetup, setShowVoiceSetup] = useState(false);
  const [controllerShown, setControllerShown] = useControllerShown();
  const [terminalHeight, setTerminalHeight] = useState(0);
  const terminalWidth = useRef(0);
  const [voiceSaved, setVoiceSaved] = useState(false);
  useEffect(() => {
    if (!voiceSaved) return;
    const timer = setTimeout(() => setVoiceSaved(false), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [voiceSaved]);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Input waits for a live terminal. While the connection comes back the last screen stays at full
  // strength and keys wait for it (useTerminal); past the grace window it dims.
  const stopped = terminal.status === 'stopped';
  const disabled = (terminal.status !== 'ready' && !stopped) || !live;
  const shown = terminal.status === 'ready' || terminal.hasContent;
  // A terminal that has shown a screen covers a reload with its plain background; only a first open draws lines.
  const [drawn, setDrawn] = useState(false);
  if (terminal.hasContent && !drawn) setDrawn(true);
  const blank = terminal.status === 'loading' && !terminal.hasContent;
  // A tab this screen just started keeps the mask until its agent draws, not a bare prompt.
  const starting = terminal.agentStarting && (panel.state.customState as TerminalPanelState | undefined)?.isCliPanel === true;
  // A revisit paints the rows this tab showed last time until its screen is read again.
  const kept = blank && !drawn && !starting ? terminal.keptScreen : null;
  useJourneyMark('terminal', 'last-screen', kept !== null);
  useJourneyMark('terminal', 'content', terminal.hasContent);
  useJourneyMark('terminal', 'live', !disabled);
  useLiveMarks('terminal', !disabled);

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
      const mayHaveLanded = error instanceof RemoteUnconfirmedResultError || (error instanceof PaneError && error.code === 'ERR_REMOTE_DELIVERY_UNKNOWN');
      setSendError(mayHaveLanded
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
      <View
        style={[styles.fill, { backgroundColor: theme.terminal.background }]}
        onLayout={({ nativeEvent: { layout } }) => {
          // A fold or a turn: this layout lands before the page refits, so the cover goes up first.
          if (terminalWidth.current > 0 && layout.width !== terminalWidth.current) terminal.coverRefit();
          terminalWidth.current = layout.width;
          setTerminalHeight(layout.height);
        }}
      >
        <Dimmed dimmed={disabled} style={styles.fill}>
          <View style={styles.screen}>
            <TerminalTouchSurface rows={terminal.rows} onScrollLines={terminal.scrollLines} onPan={readOnly ? terminal.pan : undefined}>
              <TerminalWebView
                ref={terminal.webView}
                onMessage={terminal.onMessage}
                screenText={terminal.screenText}
                onProcessGone={terminal.reload}
              />
            </TerminalTouchSurface>
          </View>
          {shown && controllerShown && !readOnly ? (
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
        {/*
          Only a failure while connected replaces the screen; a mask covers a blank one, hiding the
          page's load and refit. A revisit masks with the rows it showed last time; a first open, or
          an agent this screen is starting, with skeleton lines, opaque from the first frame.
        */}
        {kept !== null ? (
          // An old screen dims like the live one once the computer is unreachable, so it never looks live.
          <Dimmed dimmed={!live} style={StyleSheet.absoluteFill}>
            <KeptScreen text={kept} rows={terminal.rows} height={terminalHeight} />
          </Dimmed>
        ) : null}
        <SkeletonSwap
          loading={(blank && !drawn && kept === null) || starting}
          skeleton={<TerminalSkeleton testID="terminal-skeleton" label="Loading terminal" style={StyleSheet.absoluteFill} />}
        >
          {null}
        </SkeletonSwap>
        {terminal.status === 'error' ? (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: theme.terminal.background }]}>
            <ErrorState title="Terminal unavailable" error={terminal.error} onRetry={terminal.retry} testID="terminal-error" />
          </View>
        ) : stopped ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.terminal.background }]}>
            <EmptyState testID="terminal-not-running" title="Not running" message={`This tab isn’t running on ${profile.label}. Its output shows here once someone starts it there.`} />
          </View>
        ) : (blank && drawn) || terminal.refitting ? (
          <View testID="terminal-refreshing" style={[StyleSheet.absoluteFill, { backgroundColor: theme.terminal.background }]} />
        ) : null}
      </View>
      {readOnly ? null : <>
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
      </>}
    </>
  );
}

/** The space under a screen's last row: the bottom safe area, or a hair above the keyboard while it is up. */
export function BottomGap() {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  return <View style={{ height: keyboardVisible ? KEYBOARD_GAP : insets.bottom }} />;
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
  hidden: { display: 'none' },
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
