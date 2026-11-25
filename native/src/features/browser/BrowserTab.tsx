import type { BrowserFrame, BrowserInput, BrowserTabView } from '@shared/types/browserStream';
import type { BrowserPanelState, ToolPanel } from '@shared/types/panels';
import { isHostLocalUrl, normalizeUrl } from '@shared/utils/browserUrl';
import { browserInputQueue, fitFrame, keyboardField, movesFocus, pagePoint, PhoneControl, type FrameBox } from '@shared/utils/browserStreamInput';
import * as Clipboard from 'expo-clipboard';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Image, Keyboard, Linking, Modal, PixelRatio, Platform, Pressable, StyleSheet, TextInput, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Button, Icon, Text } from '@/ui';
import type { IconProps } from '@/ui/Icon';

import { isDemoProfile } from '../demo/demoHost';
import { pickFiles, type AttachSource } from '../upload/pickFiles';
import { splitAddress } from './browserPage';
import { driverChip, KEYBOARD_EMPTY, keyboardEdit, liveLine, stopLine } from './browserStream';
import { OwnCopyBrowserTab } from './OwnCopyBrowserTab';
import { browserChannels, useBrowserStream } from './useBrowserStream';
import { useStreamChoice } from './useStreamChoice';

/** How long the agent's cursor stays at a click before it fades (as on the host's own tab). */
const CURSOR_SHOWN_MS = 1_200;
/** A touch held this long without moving is a right click. */
const LONG_PRESS_MS = 550;
/** A touch that moves this far is a scroll, not a tap. */
const TAP_SLOP_PX = 8;
const NOTICE_MS = 4_000;

/**
 * A page tab. It shows the phone's own copy of the page until an agent acts on it; then it streams
 * the page from the computer that owns the Pane, where the agent works, and the phone sends touch
 * and typing back, until 30 s after its driver clears or Back to my copy; a page the agent typed into,
 * or one the person chose View live on, streams until Back to my copy (docs/BROWSER_AGENTS.md). Host files and dev servers always stay a copy. The address field and who
 * drives sit on top, Back, Forward, Reload and the keyboard at the bottom. A computer on an older
 * Pane streams nothing: the phone then keeps its own copy.
 */
/** The most a page takes from the phone's file picker in one go (the host's limit). */
const UPLOAD_LIMIT_BYTES = 10 * 1_048_576;

export function BrowserTab({ panel }: { panel: ToolPanel }) {
  const { profile } = useDaemon();
  const state = panel.state.customState as BrowserPanelState | undefined;
  const choice = useStreamChoice(panel.id, state);
  // The demo's pages are sample files on the phone.
  if (isDemoProfile(profile)) return <OwnCopyBrowserTab panel={panel} />;
  const hostLocal = isHostLocalUrl(state?.currentUrl);
  // A sign-in popup always streams, even on a localhost callback: a copy would lose its opener.
  if (!state?.signInPopup && (hostLocal || !choice.stream)) {
    const driver = state?.driver;
    return (
      <View style={styles.fill}>
        {driver?.by === 'person' ? <HandBackRow panelId={panel.id} agent={driver.agentWaiting} /> : null}
        <OwnCopyBrowserTab panel={panel} onViewLive={state?.agentUse && !hostLocal ? choice.live : undefined} />
      </View>
    );
  }
  // A sign-in popup's page exists only on the host: there is no copy to go back to.
  return <StreamedBrowserTab panel={panel} onBack={state?.signInPopup ? undefined : choice.back} onInput={choice.input} />;
}

/** On the own copy while the person drives the tab (they took over): hand it back to the agent from here. */
function HandBackRow({ panelId, agent }: { panelId: string; agent: string | undefined }) {
  const { colors } = useTheme();
  const { client } = useDaemon();
  const [failed, setFailed] = useState(false);
  return (
    <View testID="browser-hand-back" style={[styles.live, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
      <Text variant="footnote" tone={failed ? 'danger' : 'secondary'} numberOfLines={1} style={styles.shrink}>{failed ? "That didn't reach the computer. Try again." : agent ? `You're driving · ${agent} is waiting` : "You're driving"}</Text>
      <Pressable accessibilityRole="button" hitSlop={6} onPress={() => { setFailed(false); void browserChannels(client).driver(panelId, 'agent').catch(() => setFailed(true)); }}>
        <Text variant="footnote" style={{ color: colors.accentText }}>{`Hand to ${agent ?? 'agent'}`}</Text>
      </Pressable>
    </View>
  );
}

function StreamedBrowserTab({ panel, onBack, onInput }: { panel: ToolPanel; onBack: (() => void) | undefined; onInput(): void }) {
  const theme = useTheme();
  const { colors } = theme;
  const { client, profile } = useDaemon();
  const focused = useIsFocused();
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  const [box, setBox] = useState<{ width: number; height: number }>();
  // The page keeps the size the stage has without the keyboard: opening or closing it never resizes the host's page.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    // iOS moves the layout on keyboardWill*, so the guard must be set by then (as TerminalScreen does).
    const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardOpen(true));
    const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardOpen(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  const [space, setSpace] = useState(box);
  useEffect(() => { if (box && !keyboardOpen) setSpace(box); }, [box, keyboardOpen]);
  const stream = useBrowserStream(panel.id, focused && active, space && { ...space, scale: PixelRatio.get() });
  const { frame, view, stop } = stream;
  const host = view?.host || profile.label;

  // Input goes to the host in order through one queue for the tab's life.
  const clientRef = useRef(client);
  useEffect(() => { clientRef.current = client; }, [client]);
  const keysRef = useRef<TextInput>(null);
  const [field, setField] = useState<'text' | 'password' | null>(null);
  const [keyboardText, setKeyboardText] = useState(KEYBOARD_EMPTY);
  // What the field holds after the last edit: changes can arrive faster than a render, so each one
  // is compared with this, never with the last rendered text.
  const keyboardTextRef = useRef(KEYBOARD_EMPTY);
  const [notice, setNotice] = useState<string>();
  const fieldRef = useRef<'text' | 'password' | null>(null);
  const [queue] = useState(() => browserInputQueue(async batch => {
    const result = await browserChannels(clientRef.current).input(panel.id, batch);
    if (result.copied) void Clipboard.setStringAsync(result.copied).catch(() => undefined);
    const tapped = batch.some(input => input.kind === 'mouse' && input.action === 'up' && input.button === 'left');
    const field = keyboardField(batch, result.field);
    // Every tap into a field starts the keyboard's text afresh, so the last field's text never edits this one.
    if (field !== undefined && (field !== fieldRef.current || tapped)) {
      fieldRef.current = field;
      setField(field);
      keyboardTextRef.current = KEYBOARD_EMPTY;
      setKeyboardText(KEYBOARD_EMPTY);
    }
    // A tap on a text field opens the keyboard; a tap anywhere else closes it.
    if (tapped && field) keysRef.current?.focus();
    else if (tapped && field === null) keysRef.current?.blur();
    return result;
  }));
  // Input made while the host can't be reached is dropped, never replayed late onto a page that may have changed.
  const stopRef = useRef(stop);
  useEffect(() => { stopRef.current = stop; }, [stop]);
  // The person's clicks, keys and scrolls keep the stream shown (useStreamChoice).
  const onInputRef = useRef(onInput);
  useEffect(() => { onInputRef.current = onInput; }, [onInput]);
  const send = useCallback((input: BrowserInput | null) => {
    if (stopRef.current && stopRef.current !== 'older') return;
    onInputRef.current();
    // After Enter, Tab or a navigation the page may focus a password field by itself: type securely until the host says.
    if (movesFocus(input)) {
      fieldRef.current = 'password';
      setField('password');
    }
    queue(input);
  }, [queue]);
  const [control] = useState(() => new PhoneControl());
  useEffect(() => { if (view) control.view(view); }, [control, view]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const page = frame ? { width: frame.width, height: frame.height } : undefined;
  const drawn = box && page ? fitFrame(box, page) : undefined;
  const toPage = (x: number, y: number) => (box && page ? pagePoint(x, y, box, page) : undefined);

  // Touch: a tap is a touch tap, a drag scrolls, a long press is a right click. The first touch
  // while another screen or an agent has the page only takes control.
  const takesControl = () => {
    if (!control.touch()) return false;
    send(null);
    return true;
  };
  const onTap = (x: number, y: number) => {
    if (stop === 'asleep') { stream.wake(); return; }
    const point = toPage(x, y);
    if (!point || takesControl()) return;
    // A tap goes as a mouse click: Chromium makes no click (or one in the wrong place) from a
    // synthetic touch on a page shown at another size.
    send({ kind: 'mouse', action: 'down', ...point, button: 'left', clicks: 1, modifiers: 0 });
    send({ kind: 'mouse', action: 'up', ...point, button: 'left', clicks: 1, modifiers: 0 });
  };
  const onLongPress = (x: number, y: number) => {
    const point = toPage(x, y);
    if (!point || takesControl()) return;
    send({ kind: 'mouse', action: 'down', ...point, button: 'right', clicks: 1, modifiers: 0 });
    send({ kind: 'mouse', action: 'up', ...point, button: 'right', clicks: 1, modifiers: 0 });
  };
  const dragTookControl = useRef(false);
  const onDragStart = () => { dragTookControl.current = takesControl(); };
  const onDrag = (x: number, y: number, dx: number, dy: number) => {
    const point = toPage(x, y);
    if (!point || !page || !drawn || dragTookControl.current) return;
    const scale = page.width / drawn.width;
    send({ kind: 'wheel', ...point, dx: -dx * scale, dy: -dy * scale });
  };
  const lastX = useSharedValue(0);
  const lastY = useSharedValue(0);
  const tap = Gesture.Tap()
    .maxDistance(TAP_SLOP_PX)
    .onEnd((event, success) => { if (success) scheduleOnRN(onTap, event.x, event.y); });
  const longPress = Gesture.LongPress()
    .minDuration(LONG_PRESS_MS)
    .maxDistance(TAP_SLOP_PX)
    .onStart(event => scheduleOnRN(onLongPress, event.x, event.y));
  // Vertical drags scroll; one that starts sideways fails here, so the screen's swipe-back still works.
  const pan = Gesture.Pan()
    .activeOffsetY([-TAP_SLOP_PX, TAP_SLOP_PX])
    .failOffsetX([-12, 12])
    .onStart(() => {
      lastX.value = 0;
      lastY.value = 0;
      scheduleOnRN(onDragStart);
    })
    .onUpdate(event => {
      scheduleOnRN(onDrag, event.x, event.y, event.translationX - lastX.value, event.translationY - lastY.value);
      lastX.value = event.translationX;
      lastY.value = event.translationY;
    });

  // Typing: a hidden field carries the phone's keyboard into the page's focused field.
  const onType = (after: string) => {
    const edit = keyboardEdit(keyboardTextRef.current, after, fieldRef.current === 'password');
    keyboardTextRef.current = edit.next;
    for (const input of edit.input) send(input);
    setKeyboardText(edit.next);
  };

  // The address field: Go navigates on the host.
  const [draft, setDraft] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const go = () => {
    const text = draft?.trim();
    setDraft(null);
    if (!text) return;
    const url = normalizeUrl(text);
    if (!/^https?:\/\//i.test(url)) {
      setAddressError('Enter a web address, like localhost:5173 or example.com.');
      return;
    }
    setAddressError(null);
    send({ kind: 'navigate', url });
  };
  const [addressHost, addressPath] = splitAddress(view?.url ?? '');

  // Who drives: the agent's cursor fades after a moment; the last agent names "Hand to".
  const [lastAgent, setLastAgent] = useState<string>();
  const agentName = view?.driver?.by === 'agent' ? view.driver.agent : lastAgent;
  if (agentName !== lastAgent) setLastAgent(agentName);
  const agentDriving = view?.driver?.by === 'agent';
  const chip = view?.driver ? driverChip(view.driver, agentName) : undefined;

  // The page's dialogs, file pickers and downloads.
  const dialog = view?.dialog;
  const [prompt, setPrompt] = useState<{ message: string; text: string } | null>(null);
  const shownDialog = useRef<string | null>(null);
  useEffect(() => {
    if (!dialog) { shownDialog.current = null; setPrompt(null); return; }
    const key = `${dialog.type}\n${dialog.message}`;
    if (shownDialog.current === key) return;
    shownDialog.current = key;
    const answer = (accept: boolean) => send({ kind: 'dialog', accept });
    if (dialog.type === 'prompt') setPrompt({ message: dialog.message, text: dialog.defaultPrompt ?? '' });
    else if (dialog.type === 'alert') Alert.alert(host, dialog.message, [{ text: 'OK', onPress: () => answer(true) }], { cancelable: false });
    else Alert.alert(host, dialog.message || 'Leave this page?', [{ text: 'Cancel', style: 'cancel', onPress: () => answer(false) }, { text: 'OK', onPress: () => answer(true) }], { cancelable: false });
  }, [dialog, host, send]);

  const fileChooser = view?.fileChooser;
  const choosing = useRef(false);
  useEffect(() => {
    if (!fileChooser) { choosing.current = false; return; }
    if (choosing.current) return;
    choosing.current = true;
    const choose = async (source: AttachSource) => {
      try {
        const picked = await pickFiles(source);
        if (picked.length === 0) { send({ kind: 'files-cancel' }); return; }
        const chosen = fileChooser.multiple ? picked : picked.slice(0, 1);
        const bytes = chosen.reduce((sum, file) => sum + file.size, 0);
        if (bytes > UPLOAD_LIMIT_BYTES) {
          send({ kind: 'files-cancel' });
          setNotice(`The files come to ${(bytes / 1_048_576).toFixed(1)} MB; a page takes up to ${UPLOAD_LIMIT_BYTES / 1_048_576} MB from the phone at once.`);
          return;
        }
        const files = await Promise.all(chosen.map(async file => ({ name: file.name, data: await file.read(0, file.size) })));
        send({ kind: 'files', files });
      } catch (cause) {
        send({ kind: 'files-cancel' });
        setNotice(`The file was not sent: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    };
    Alert.alert(`The page asks for ${fileChooser.multiple ? 'files' : 'a file'}`, `It goes to ${host}.`, [
      { text: 'Files', onPress: () => void choose('files') },
      { text: 'Photos', onPress: () => void choose('photos') },
      { text: 'Cancel', style: 'cancel', onPress: () => send({ kind: 'files-cancel' }) },
    ], { cancelable: false });
  }, [fileChooser, host, send]);

  const [signInOpened, setSignInOpened] = useState<string | null>(null);
  // The host drops the sign-in when the page loads again, so the next refusal shows its line.
  if (!view?.signIn && signInOpened !== null) setSignInOpened(null);
  const download = view?.downloads.at(-1);
  const seenDownload = useRef<number | null>(null);
  useEffect(() => {
    if (!view) return;
    // Downloads from before the tab opened here stay quiet.
    if (seenDownload.current === null) { seenDownload.current = download?.at ?? 0; return; }
    if (!download || download.at <= seenDownload.current) return;
    seenDownload.current = download.at;
    setNotice(`Downloaded ${download.name} on ${host}`);
  }, [view, download, host]);
  useEffect(() => {
    if (stream.reloadedAt !== undefined) setNotice(`The page reloaded on ${host}.`);
  }, [stream.reloadedAt, host]);

  if (stop === 'older') {
    return (
      <View style={[styles.fill, { backgroundColor: colors.background }]}>
        <Text testID="browser-older-host" variant="footnote" tone="secondary" style={[styles.olderLine, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>{stopLine('older', profile.label)}</Text>
        <OwnCopyBrowserTab panel={panel} />
      </View>
    );
  }

  const history = (to: 'back' | 'forward' | 'reload') => send({ kind: 'history', go: to });
  const line = stop ? stopLine(stop, host) : notice;

  return (
    <View testID="browser-tab" style={[styles.fill, { backgroundColor: colors.background }]}>
      <View style={[styles.top, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
        <View style={[styles.address, { borderRadius: theme.radius.md, backgroundColor: colors.surfaceRaised }]}>
          {draft === null ? (
            <Pressable
              testID="browser-address"
              accessibilityRole="button"
              accessibilityLabel={`Address, ${view?.url || 'empty'}`}
              accessibilityHint="Edit the address"
              onPress={() => setDraft(view?.url ?? '')}
              style={styles.addressText}
            >
              <Text variant="subhead" numberOfLines={1}>
                <Text variant="subhead" style={styles.semibold}>{addressHost || 'Enter an address'}</Text>
                {addressPath ? <Text variant="subhead" tone="muted">{` ${addressPath}`}</Text> : null}
              </Text>
            </Pressable>
          ) : (
            <TextInput
              testID="browser-address-input"
              accessibilityLabel="Address"
              autoFocus
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={go}
              onBlur={() => setDraft(null)}
              selectTextOnFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              placeholder="Enter an address"
              placeholderTextColor={colors.textMuted}
              style={[theme.typography.subhead, styles.input, { color: colors.text }]}
            />
          )}
        </View>
        {/* One fixed-height row, so the page never shifts as drivers come and go. */}
        <View style={styles.chipRow}>
          {chip ? (
            <View testID="browser-driver" style={[styles.chip, { borderColor: agentDriving ? colors.accent : colors.border }]}>
              <Text variant="footnote" numberOfLines={1} style={styles.shrink}>{chip.label}</Text>
              <Pressable testID="browser-driver-action" accessibilityRole="button" hitSlop={6} onPress={() => {
                if (stopRef.current && stopRef.current !== 'older') return;
                onInput();
                void browserChannels(client).driver(panel.id, chip.to).catch(() => setNotice(`That didn't reach ${host}. Try again.`));
              }}>
                <Text variant="footnote" style={{ color: colors.accentText }}>{chip.action}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
      <View testID="browser-live" style={[styles.live, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
        <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.shrink}>{liveLine(host)}</Text>
        {onBack ? (
          <Pressable testID="browser-back-to-copy" accessibilityRole="button" hitSlop={6} onPress={onBack}>
            <Text variant="footnote" style={{ color: colors.accentText }}>Back to my copy</Text>
          </Pressable>
        ) : null}
      </View>
      {view?.signIn && view.signIn.url !== signInOpened ? (
        <View testID="browser-sign-in" style={[styles.live, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
          <Text variant="footnote" tone="secondary" style={styles.shrink}>{`${view.signIn.site} won't sign in here.`}</Text>
          <Pressable accessibilityRole="button" hitSlop={6} onPress={() => { const { url } = view.signIn ?? {}; if (!url) return; setSignInOpened(url); void Linking.openURL(url); }}>
            <Text variant="footnote" style={{ color: colors.accentText }}>Open this page in your browser</Text>
          </Pressable>
        </View>
      ) : null}
      {addressError ? (
        <Pressable testID="browser-input-error" onPress={() => setAddressError(null)} accessibilityHint="Dismiss" style={styles.notice}>
          <Text variant="footnote" tone="danger">{addressError}</Text>
        </Pressable>
      ) : null}
      <View style={styles.track}>
        {view?.loading ? <View style={[styles.track, { backgroundColor: colors.accent }]} /> : null}
      </View>
      <GestureDetector gesture={Gesture.Race(pan, longPress, tap)}>
        <View
          testID="browser-stream"
          accessibilityLabel={view?.title || 'Page'}
          style={[styles.fill, styles.stage, { backgroundColor: colors.surfaceRaised }]}
          onLayout={(event: LayoutChangeEvent) => setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
        >
          {frame && drawn ? <FrameView frame={frame} drawn={drawn} dim={stop !== undefined} /> : null}
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.outline, { borderColor: agentDriving ? colors.accent : 'transparent' }]} />
          {view?.agentCursor && page && drawn && agentDriving ? <AgentCursor cursor={view.agentCursor} page={page} drawn={drawn} /> : null}
          {!frame && !stop ? (
            <View pointerEvents="none" style={styles.center}><Text variant="footnote" tone="muted">{`Loading the page on ${host}…`}</Text></View>
          ) : null}
          {line ? (
            <View pointerEvents="none" style={styles.lineRow}>
              <Text testID="browser-stream-line" variant="footnote" tone="secondary" style={[styles.line, { backgroundColor: colors.surface, borderColor: colors.border }]}>{line}</Text>
            </View>
          ) : null}
          <TextInput
            ref={keysRef}
            testID="browser-keys"
            accessibilityLabel="Type into the page"
            value={keyboardText}
            onChangeText={onType}
            onSubmitEditing={() => { send({ kind: 'key', key: 'Enter', modifiers: 0 }); keyboardTextRef.current = KEYBOARD_EMPTY; setKeyboardText(KEYBOARD_EMPTY); }}
            submitBehavior="submit"
            secureTextEntry={field === 'password'}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={field !== 'password'}
            caretHidden
            style={styles.keys}
          />
        </View>
      </GestureDetector>
      <View testID="browser-bar" style={[styles.bar, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
        <ToolButton testID="browser-back" label="Back" ios="chevron.left" android="arrow_back" disabled={!view?.canGoBack} onPress={() => history('back')} />
        <ToolButton testID="browser-forward" label="Forward" ios="chevron.right" android="arrow_forward" disabled={!view?.canGoForward} onPress={() => history('forward')} />
        <ToolButton testID="browser-reload" label="Reload" ios="arrow.clockwise" android="refresh" disabled={!view?.url} onPress={() => history('reload')} />
        <ToolButton testID="browser-keyboard" label="Keyboard" ios="keyboard" android="keyboard" onPress={() => (keysRef.current?.isFocused() ? keysRef.current.blur() : keysRef.current?.focus())} />
      </View>
      <Modal visible={prompt !== null} transparent animationType="fade" onRequestClose={() => { setPrompt(null); send({ kind: 'dialog', accept: false }); }} statusBarTranslucent>
        <View style={[styles.scrim, { backgroundColor: colors.scrim }]}>
          <View testID="browser-prompt" style={[styles.card, { backgroundColor: colors.surface, borderRadius: theme.radius.md }]}>
            <Text variant="body">{prompt?.message ?? ''}</Text>
            <TextInput
              testID="browser-prompt-input"
              autoFocus
              value={prompt?.text ?? ''}
              onChangeText={text => setPrompt(current => (current ? { ...current, text } : current))}
              placeholderTextColor={colors.textMuted}
              style={[theme.typography.body, styles.promptInput, { color: colors.text, borderColor: colors.border, borderRadius: theme.radius.md }]}
            />
            <View style={styles.cardButtons}>
              <Button title="Cancel" variant="secondary" onPress={() => { setPrompt(null); send({ kind: 'dialog', accept: false }); }} />
              <Button title="OK" onPress={() => { send({ kind: 'dialog', accept: true, text: prompt?.text ?? '' }); setPrompt(null); }} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/**
 * The page's newest frame, letterboxed in its box. Two images take turns: a new frame loads in
 * the hidden one and shows once decoded, so the page never blanks between frames.
 */
function FrameView({ frame, drawn, dim }: { frame: BrowserFrame; drawn: FrameBox; dim: boolean }) {
  const [shown, setShown] = useState<{ slot: 'a' | 'b'; uri?: string }>({ slot: 'a' });
  const place = { left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height };
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, dim && styles.dim]}>
      {(['a', 'b'] as const).map(slot => {
        const uri = slot === shown.slot ? shown.uri : frame.data !== shown.uri ? frame.data : undefined;
        if (!uri) return null;
        return (
          <Image
            key={slot}
            testID={slot === shown.slot ? 'browser-frame' : undefined}
            source={{ uri }}
            resizeMode="contain"
            fadeDuration={0}
            onLoad={() => { if (slot !== shown.slot) setShown({ slot, uri }); }}
            style={[styles.frame, place, { opacity: slot === shown.slot ? 1 : 0 }]}
          />
        );
      })}
    </View>
  );
}

/** Where the agent last clicked, shown for a moment and then faded out. */
function AgentCursor({ cursor, page, drawn }: { cursor: NonNullable<BrowserTabView['agentCursor']>; page: { width: number; height: number }; drawn: FrameBox }) {
  const { colors } = useTheme();
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.value = 1;
    opacity.value = withDelay(CURSOR_SHOWN_MS, withTiming(0, { duration: 200 }));
  }, [opacity, cursor.x, cursor.y, cursor.at]);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      testID="browser-agent-cursor"
      pointerEvents="none"
      style={[styles.cursor, { left: drawn.left + (cursor.x / page.width) * drawn.width, top: drawn.top + (cursor.y / page.height) * drawn.height }, fade]}
    >
      <Icon ios="cursorarrow" android="arrow_selector_tool" size={20} color={colors.accent} />
    </Animated.View>
  );
}

function ToolButton({ testID, label, ios, android, disabled, onPress }: {
  testID: string;
  label: string;
  ios: IconProps['ios'];
  android: IconProps['android'];
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [styles.tool, disabled && styles.disabled, { borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
    >
      <Icon ios={ios} android={android} size={20} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  top: { paddingHorizontal: 8, paddingTop: 6, borderBottomWidth: 1 },
  address: { height: 36, justifyContent: 'center', paddingHorizontal: 10 },
  addressText: { flex: 1, justifyContent: 'center' },
  input: { flex: 1, padding: 0 },
  semibold: { fontWeight: '600' },
  shrink: { flexShrink: 1 },
  chipRow: { height: 36, alignItems: 'center', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '100%', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  notice: { paddingHorizontal: 12, paddingVertical: 6 },
  track: { height: 2 },
  stage: { overflow: 'hidden' },
  frame: { position: 'absolute' },
  dim: { opacity: 0.4 },
  outline: { borderWidth: 2 },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  lineRow: { position: 'absolute', left: 12, right: 12, bottom: 12, alignItems: 'center' },
  line: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, overflow: 'hidden', textAlign: 'center' },
  cursor: { position: 'absolute' },
  keys: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderTopWidth: 1 },
  tool: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.35 },
  live: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  olderLine: { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1 },
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { alignSelf: 'stretch', padding: 20, gap: 16 },
  promptInput: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  cardButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
