import * as Linking from 'expo-linking';
import type { ReactNode } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { DataDetectorTypes } from 'react-native-webview/lib/WebViewTypes';

import type { AutopilotDocument } from '@shared/types/autopilot';
import { withSummaryPolicy } from '@shared/utils/summaryPolicy';

import { useDaemon, useInvokeQuery } from '@/daemon';
import { browserPage } from '@/features/browser/browserPage';
import { usePorts } from '@/features/browser/usePorts';
import { StateScreen } from '@/features/tabs/StateScreen';
import { monoFontFamily, useTheme } from '@/theme';
import { Button, ErrorState, Skeleton, SkeletonSwap, Text } from '@/ui';

import { pageLoad } from './pages';

// An array: Android passes this prop to native as it is, and a bare string aborts the app. One
// constant, since iOS warns when it changes between renders.
const NO_DATA_DETECTORS: DataDetectorTypes[] = ['none'];

/**
 * An html page drawn as it is, with scripts off: the WebView turns JavaScript off and injects
 * nothing. It loads only the page and its own anchors; a tapped web link opens in the phone's
 * browser, and every other navigation is refused. The Summary and linked files use it.
 */
export function StaticPage({ html, testID }: { html: string; testID: string }) {
  const { colors } = useTheme();
  return (
    <WebView
      testID={testID}
      source={{ html }}
      // Every URL reaches onShouldStartLoadWithRequest, which decides for all of them. A narrower
      // list would hand the URLs it doesn't match to the phone to open (react-native-webview).
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={request => {
        const action = pageLoad(request.url, request.isTopFrame ?? true);
        if (action === 'open') void Linking.openURL(request.url);
        return action === 'load';
      }}
      javaScriptEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      dataDetectorTypes={NO_DATA_DETECTORS}
      cacheEnabled={false}
      style={[styles.fill, { backgroundColor: colors.surface }]}
    />
  );
}

/** A page's footprint while it loads: a heading and two paragraphs. */
export function PageSkeleton({ testID, label }: { testID: string; label: string }) {
  const { colors } = useTheme();
  return (
    <View testID={testID} accessible accessibilityLabel={label} style={[styles.fill, styles.page, { backgroundColor: colors.surface }]}>
      <Skeleton width="60%" height={22} style={styles.heading} />
      {[[1, 0.95, 0.9, 0.55], [0.95, 1, 0.7]].map(lines => (
        <View key={lines.join()} style={styles.paragraph}>
          {lines.map((width, index) => <Skeleton key={index} width={`${width * 100}%`} height={14} />)}
        </View>
      ))}
    </View>
  );
}

/**
 * A linked file read through the phone's connection (`autopilot:read-doc`, as the desktop's
 * Approvals tabs read it): an html page drawn as a `StaticPage` under the Summary's content
 * policy (nothing from the network, no form posts), any other file as text.
 */
export function FileDoc({ path }: { path: string }) {
  const { colors } = useTheme();
  const { profile } = useDaemon();
  const name = path.split('/').pop() ?? path;
  const doc = useInvokeQuery<AutopilotDocument>('autopilot:read-doc', [path, { inline: true }], { retry: false });
  const read = doc.data;
  let content: ReactNode = null;
  if (doc.isError) content = <ErrorState title={`Couldn’t open ${name}`} error={doc.error} onRetry={() => void doc.refetch()} testID="autopilot-doc-error" />;
  else if (read?.kind === 'missing') content = <StateScreen testID="autopilot-doc-missing" icon={{ ios: 'doc.questionmark', android: 'draft' }} title={`Can’t open ${name}`} message={read.message} />;
  else if (read?.kind === 'image') content = <Image testID="autopilot-doc-image" source={{ uri: read.dataUrl }} resizeMode="contain" style={styles.fill} accessibilityLabel={name} />;
  else if (read?.kind === 'html') {
    content = read.html === undefined
      // A computer from before the phone could read pages inline sends only its file URL.
      ? <StateScreen testID="autopilot-doc-update" icon={{ ios: 'arrow.down.circle', android: 'system_update' }} title="Update Pane on the computer" message={`${profile.label}’s Pane is too old to send this page to the phone. Update it, or open the page in Pane there.`} />
      : <StaticPage testID="autopilot-doc-page" html={withSummaryPolicy(read.html)} />;
  }
  else if (read) {
    content = (
      <ScrollView testID="autopilot-doc-text" style={styles.fill} contentContainerStyle={styles.text}>
        <Text variant="footnote" selectable style={{ fontFamily: monoFontFamily, color: colors.text }}>{read.text}</Text>
      </ScrollView>
    );
  }
  return <SkeletonSwap loading={doc.isPending} skeleton={<PageSkeleton testID="doc-skeleton" label={`Loading ${name}`} />} style={styles.fill}>{content}</SkeletonSwap>;
}

/** A page: through the phone addresses the computer makes for its dev servers, or the address itself. */
export function UrlDoc({ url }: { url: string }) {
  const page = browserPage(url, usePorts(), 'autopilot');
  return (
    <SkeletonSwap loading={page.kind === 'loading'} skeleton={<PageSkeleton testID="doc-skeleton" label="Loading the page" />} style={styles.fill}>
      <UrlDocBody url={url} page={page} />
    </SkeletonSwap>
  );
}

function UrlDocBody({ url, page }: { url: string; page: ReturnType<typeof browserPage> }) {
  // As the page tabs do: every scheme stays in the view, and a link that asks for a new window opens here.
  if (page.kind === 'web') return <WebView testID="autopilot-doc-page" source={{ uri: page.src }} originWhitelist={['*']} setSupportMultipleWindows={false} style={styles.fill} />;
  if (page.kind === 'loading') return null;
  let message = 'The phone can’t load this page here.';
  if (page.kind === 'refused') message = `Nothing is listening on port ${page.port} on the computer right now.`;
  else if (page.kind === 'pages-off') message = page.reason;
  else if (page.kind === 'update') message = 'The computer’s Pane is too old to share its pages with the phone.';
  return <StateScreen testID="autopilot-doc-unavailable" icon={{ ios: 'globe', android: 'language' }} title={`Can’t open ${page.address || url}`} message={message}
    actions={/^https?:/i.test(url) ? <Button title="Open in the browser" variant="secondary" onPress={() => void Linking.openURL(url)} /> : undefined} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  text: { padding: 16 },
  page: { padding: 16, gap: 18 },
  heading: { marginBottom: 4 },
  paragraph: { gap: 8 },
});
