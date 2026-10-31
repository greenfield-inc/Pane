import type { BrowserPanelState, ToolPanel } from '@shared/types/panels';
import { normalizeUrl } from '@shared/utils/browserUrl';
import * as Linking from 'expo-linking';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { useDaemon, useInvokeMutation, useInvokeQuery } from '@/daemon';
import { useTheme } from '@/theme';
import { Button, ErrorState, Icon, Text } from '@/ui';

import { isDemoProfile } from '../demo/demoHost';
import { useConnectionPresence } from '../hosts/useConnectionPresence';
import { browserPage, htmlFromBase64, splitAddress, type BrowserPage } from './browserPage';
import { StateScreen } from '../tabs/StateScreen';
import { usePorts } from './usePorts';

const TAILSCALE_APP_URL = 'tailscale://';
const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download/ios';

/**
 * A page tab: the address row (back, forward, address, reload, Safari) over the live page. Pages
 * on the computer load through the phone addresses it creates over Tailscale; HTML files fall
 * back to reading the file through the computer. Each case that can't load has its own screen.
 */
export function BrowserTab({ panel }: { panel: ToolPanel }) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const { presence, retry } = useConnectionPresence();
  const read = usePorts();
  const url = (panel.state.customState as BrowserPanelState | undefined)?.currentUrl ?? '';
  const webView = useRef<WebView>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [progress, setProgress] = useState(1);
  // The load that last finished, so the opening screen covers only a page's first load.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // The page view failed to load: an unreachable phone address, or a page that refused.
  const [loadError, setLoadError] = useState<{ src: string; message: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  let page: BrowserPage = browserPage(url, read, panel.id);
  // The demo's pages are sample files on the phone.
  if (isDemoProfile(profile) && page.kind !== 'web' && page.kind !== 'empty' && page.kind !== 'invalid') page = { kind: 'file', url, address: page.address };
  // A files address the phone can't reach (not on Tailscale): read the file through the computer instead.
  if (page.kind === 'web' && url.startsWith('file:') && loadError?.src === page.src) page = { kind: 'file', url, address: page.address };

  const requestAddress = useInvokeMutation<[number]>('ports:phone-address');
  const requested = page.kind === 'loading' ? page.request : undefined;
  const asked = useRef(new Set<number>());
  useEffect(() => {
    if (requested === undefined || asked.current.has(requested)) return;
    asked.current.add(requested);
    requestAddress.mutate([requested]);
  }, [requested, requestAddress]);

  const save = useInvokeMutation<[string, Partial<ToolPanel>]>('panels:update', { invalidates: ['panels:list'] });
  const submit = () => {
    const text = draft?.trim();
    setDraft(null);
    if (!text) return;
    const next = normalizeUrl(text);
    if (!/^https?:\/\//i.test(next)) {
      setInputError('Enter a web address, like localhost:5173 or example.com.');
      return;
    }
    setInputError(null);
    setLoadError(null);
    if (next === url) {
      reload();
      return;
    }
    // Saved on the tab, so the computer's tab moves to it too.
    save.mutate([panel.id, { state: { ...panel.state, customState: { ...panel.state.customState, currentUrl: next } } }], {
      onError: error => setInputError(`Couldn’t open ${next}: ${error.message}`),
    });
  };

  const reload = () => {
    setLoadError(null);
    if (page.kind === 'web') webView.current?.reload();
    else read.refetch();
    setReloadKey(key => key + 1);
  };
  const src = page.kind === 'web' ? page.src : null;
  const loadKey = `${src}#${reloadKey}`;
  const openOutside = () => { if (src) void Linking.openURL(src); };
  const openTailscale = () => {
    Linking.openURL(TAILSCALE_APP_URL).catch(() => void Linking.openURL(TAILSCALE_DOWNLOAD_URL));
  };

  const [host, path] = splitAddress(page.address);
  const offline = presence === 'unreachable';
  const failed = page.kind === 'web' && loadError?.src === page.src;

  return (
    <View testID="browser-tab" style={[styles.fill, { backgroundColor: colors.background }]}>
      <View style={[styles.bar, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
        <ToolButton testID="browser-back" label="Back" ios="chevron.left" android="arrow_back" disabled={!nav.back} onPress={() => webView.current?.goBack()} />
        <ToolButton testID="browser-forward" label="Forward" ios="chevron.right" android="arrow_forward" disabled={!nav.forward} onPress={() => webView.current?.goForward()} />
        <View style={[styles.address, { borderRadius: theme.radius.md, backgroundColor: colors.surfaceRaised }]}>
          {draft === null ? (
            <Pressable
              testID="browser-address"
              accessibilityRole="button"
              accessibilityLabel={`Address, ${page.address || 'empty'}`}
              accessibilityHint="Edit the address"
              onPress={() => setDraft(page.address)}
              style={styles.addressText}
            >
              <Text variant="subhead" numberOfLines={1} style={styles.shrink}>
                <Text variant="subhead" style={styles.semibold}>{host || 'Enter an address'}</Text>
                {path ? <Text variant="subhead" tone="muted">{` ${path}`}</Text> : null}
              </Text>
            </Pressable>
          ) : (
            <TextInput
              testID="browser-address-input"
              accessibilityLabel="Address"
              autoFocus
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={submit}
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
        <ToolButton testID="browser-reload" label="Reload" ios="arrow.clockwise" android="refresh" onPress={reload} />
        <ToolButton testID="browser-safari" label="Open in Safari" ios="safari" android="open_in_browser" disabled={!src} onPress={openOutside} />
      </View>
      {/* One fixed-height track, so the page never shifts when loading starts or ends. */}
      <View style={styles.track}>
        {src && progress < 1 && !failed ? <View style={[styles.progress, { width: `${Math.max(progress, 0.05) * 100}%`, backgroundColor: colors.accent }]} /> : null}
      </View>
      {inputError ? (
        <Pressable testID="browser-input-error" onPress={() => setInputError(null)} accessibilityHint="Dismiss" style={styles.notice}>
          <Text variant="footnote" tone="danger">{inputError}</Text>
        </Pressable>
      ) : null}
      <View style={styles.fill}>
        {offline ? (
          <StateScreen
            testID="browser-offline"
            icon={{ ios: 'icloud.slash', android: 'cloud_off' }}
            title={`${profile.label} is offline`}
            message="The page opens again when it is back."
            actions={<Button title="Try again" variant="secondary" onPress={retry} />}
          />
        ) : page.kind === 'web' ? (
          <>
            <WebView
              key={loadKey}
              ref={webView}
              testID="browser-webview"
              source={{ uri: page.src }}
              originWhitelist={['*']}
              allowsBackForwardNavigationGestures
              allowsInlineMediaPlayback
              setSupportMultipleWindows={false}
              onNavigationStateChange={state => setNav({ back: state.canGoBack, forward: state.canGoForward })}
              onLoadProgress={event => setProgress(event.nativeEvent.progress)}
              onLoadStart={() => setProgress(0)}
              onLoadEnd={() => {
                setProgress(1);
                setLoadedKey(loadKey);
              }}
              onError={event => setLoadError({ src: page.src, message: event.nativeEvent.description })}
              onHttpError={event => { if (event.nativeEvent.url === page.src) setLoadError({ src: page.src, message: `The page answered HTTP ${event.nativeEvent.statusCode}.` }); }}
              style={[styles.fill, { backgroundColor: colors.background }]}
              webviewDebuggingEnabled={__DEV__}
            />
            {failed ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
                {page.src.includes('.ts.net') ? (
                  <StateScreen
                    testID="browser-tailscale"
                    icon={{ ios: 'shield', android: 'shield' }}
                    title={`Pages from ${profile.label} open over Tailscale`}
                    message="Turn on Tailscale on this phone to see this page. Pages from the internet still open here."
                    actions={<>
                      <Button title="Open Tailscale" onPress={openTailscale} />
                      <Button title="Safari" variant="secondary" icon={<Icon ios="safari" android="open_in_browser" size={16} color={colors.text} />} onPress={openOutside} />
                    </>}
                  />
                ) : (
                  <StateScreen
                    testID="browser-load-error"
                    icon={{ ios: 'exclamationmark.triangle', android: 'warning' }}
                    title={`Couldn’t open ${host}`}
                    message={loadError?.message ?? ''}
                    actions={<Button title="Reload" onPress={reload} />}
                  />
                )}
              </View>
            ) : loadedKey !== loadKey ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
                <LoadingScreen address={host} from={profile.label} />
              </View>
            ) : null}
          </>
        ) : page.kind === 'file' ? (
          <FileView key={reloadKey} panelId={panel.id} page={page} onNavigate={setNav} webView={webView} />
        ) : page.kind === 'loading' ? (
          read.error ? <ErrorState title="Couldn’t read the computer’s pages" error={read.error} onRetry={read.refetch} /> : <LoadingScreen address={host} from={profile.label} />
        ) : page.kind === 'refused' ? (
          <StateScreen
            testID="browser-refused"
            icon={{ ios: 'powerplug', android: 'power' }}
            title={`Nothing on ${page.host} listens on port ${page.port}`}
            message="Start the dev server there, then reload."
            actions={<Button title="Reload" icon={<Icon ios="arrow.clockwise" android="refresh" size={16} color={colors.onAccent} />} onPress={reload} />}
          />
        ) : page.kind === 'not-web' ? (
          <StateScreen
            testID="browser-not-web"
            icon={{ ios: 'powerplug', android: 'power' }}
            title={`localhost:${page.port} isn’t a web page`}
            message={`It doesn’t answer HTTP, so it opens only on ${page.host}.`}
          />
        ) : page.kind === 'pages-off' ? (
          <StateScreen
            testID="browser-pages-off"
            icon={{ ios: 'shield', android: 'shield' }}
            title={`Pages from ${page.host} don’t open on phones right now`}
            message={`${page.host} says: ${page.reason}. Pane checks again every minute. Pages from the internet still open here.`}
            actions={<Button title="Reload" variant="secondary" onPress={reload} />}
          />
        ) : page.kind === 'update' ? (
          <StateScreen
            testID="browser-update"
            icon={{ ios: 'arrow.down.circle', android: 'system_update' }}
            title={`Update Pane on ${profile.label}`}
            message={`Its Pane is too old to show its pages on phones. HTML files and pages from the internet still open here.`}
          />
        ) : (
          <StateScreen
            testID={page.kind === 'invalid' ? 'browser-invalid' : 'browser-empty'}
            icon={{ ios: 'globe', android: 'language' }}
            title={page.kind === 'invalid' ? 'This address isn’t a web address' : 'No page open'}
            message="Tap the address above and enter one, like localhost:5173."
          />
        )}
      </View>
    </View>
  );
}

/** An HTML file read through the computer, for when its files address is out of reach. Only self-contained pages load fully. */
function FileView({ panelId, page, onNavigate, webView }: {
  panelId: string;
  page: Extract<BrowserPage, { kind: 'file' }>;
  onNavigate: (nav: { back: boolean; forward: boolean }) => void;
  webView: React.RefObject<WebView | null>;
}) {
  const { colors } = useTheme();
  const { profile } = useDaemon();
  const file = useInvokeQuery<{ data: string }>('panels:read-browser-file', [panelId, page.url], { retry: false });
  if (file.isPending) return <LoadingScreen address={page.address} from={profile.label} />;
  let html: string | null = null;
  let problem: unknown = file.error;
  if (file.data) {
    try {
      html = htmlFromBase64(file.data.data);
    } catch {
      problem = new Error(`${page.address} isn’t a UTF-8 text file, so it can’t show here.`);
    }
  }
  if (html === null) return <ErrorState title={`Couldn’t open ${page.address}`} error={problem} onRetry={() => void file.refetch()} testID="browser-file-error" />;
  return (
    <WebView
      ref={webView}
      testID="browser-webview"
      source={{ html }}
      originWhitelist={['*']}
      setSupportMultipleWindows={false}
      onNavigationStateChange={state => onNavigate({ back: state.canGoBack, forward: state.canGoForward })}
      style={[styles.fill, { backgroundColor: colors.background }]}
      webviewDebuggingEnabled={__DEV__}
    />
  );
}

function LoadingScreen({ address, from }: { address: string; from: string }) {
  const { colors } = useTheme();
  return (
    <StateScreen
      testID="browser-loading"
      icon={{ ios: 'globe', android: 'language' }}
      title={`Opening ${address}`}
      message={`From ${from}`}
      actions={<ActivityIndicator color={colors.accent} />}
    />
  );
}

function ToolButton({ testID, label, ios, android, disabled, onPress }: {
  testID: string;
  label: string;
  ios: React.ComponentProps<typeof Icon>['ios'];
  android: React.ComponentProps<typeof Icon>['android'];
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
      <Icon ios={ios} android={android} size={18} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6, paddingVertical: 6, borderBottomWidth: 1 },
  tool: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.35 },
  address: { flex: 1, minWidth: 0, height: 36, marginHorizontal: 4, justifyContent: 'center', paddingHorizontal: 10 },
  addressText: { flex: 1, justifyContent: 'center' },
  input: { flex: 1, padding: 0 },
  semibold: { fontWeight: '600' },
  shrink: { flexShrink: 1 },
  track: { height: 2 },
  progress: { height: 2 },
  notice: { paddingHorizontal: 12, paddingVertical: 6 },
});
