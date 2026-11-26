import { LegendList } from '@legendapp/list/react-native';
import * as Clipboard from 'expo-clipboard';
import { useState, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Image, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useMarkdown } from 'react-native-marked';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { filePreviewKind } from '@shared/utils/filePreview';

import { useDaemon } from '@/daemon';
import { monoFontFamily, useTheme } from '@/theme';
import { Button, ErrorState, Icon, Skeleton, SkeletonSwap, Text } from '@/ui';

import { useLinkRenderer } from '../links/LinkMenu';
import { StateScreen } from '../tabs/StateScreen';
import { TabFooter } from '../tabs/TabFooter';
import { fileViewer, formatSize, highlightLines, languageOf, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, parentOf, posixPath, type Token } from './files';
import { useFileBinary, useFileText, useFolder } from './useFiles';

export interface FileViewerProps {
  /** The Pane whose worktree holds the file. */
  sessionId: string;
  /** Relative to the worktree. */
  path: string;
  /** From the folder list; read from the parent folder when unknown (an Editor tab). */
  size?: number;
  /** Explorer's row above the file: back to the folder, the file's name, and its menu. */
  back?: { label: string; onPress: () => void };
}

/**
 * One file, read-only: code with colors and line numbers, Markdown rendered (or its source), an
 * image to pinch, or a card for files that stay on the computer. Explorer and Editor tabs share it.
 */
export function FileViewer({ sessionId, path: givenPath, size: knownSize, back }: FileViewerProps) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const path = posixPath(givenPath);
  const name = path.split('/').pop() ?? path;
  const folder = useFolder(sessionId, parentOf(path), knownSize === undefined);
  const size = knownSize ?? folder.data?.find(entry => entry.path === path)?.size;
  // Only a known size within the limit lets the phone read the file.
  const viewer = fileViewer(path, size);
  const lookingUp = knownSize === undefined && folder.isPending;
  const text = useFileText(sessionId, path, viewer === 'code' || viewer === 'markdown');
  const image = useFileBinary(sessionId, path, viewer === 'image');
  const [source, setSource] = useState(false);
  const language = languageOf(path);

  const copyPath = () => void Clipboard.setStringAsync(path);
  const openMenu = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title: path, options: ['Copy path', 'Cancel'], cancelButtonIndex: 1 }, index => { if (index === 0) copyPath(); });
    } else {
      Alert.alert(name, path, [{ text: 'Cancel', style: 'cancel' }, { text: 'Copy path', onPress: copyPath }]);
    }
  };

  const loading = lookingUp || (viewer === 'image' ? image.isPending : (viewer === 'code' || viewer === 'markdown') && text.isPending);
  // Preview and Source show while a Markdown file loads too, so the header stays put when it lands.
  const markdown = viewer === 'markdown' && (text.isPending || text.data?.kind === 'text');
  const views = markdown ? (
    <View style={[styles.segments, { borderRadius: theme.radius.md, backgroundColor: colors.surfaceRaised }]} accessibilityRole="tablist">
      {(['Preview', 'Source'] as const).map(label => {
        const selected = (label === 'Source') === source;
        return (
          <Pressable
            key={label}
            testID={`file-${label.toLowerCase()}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => setSource(label === 'Source')}
            style={[styles.segment, { borderRadius: theme.radius.sm }, selected && { backgroundColor: colors.background }]}
          >
            <Text variant="callout" tone={selected ? 'primary' : 'secondary'}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  ) : null;
  // Explorer's row has the way back and the menu; an Editor tab's row has only Preview and Source.
  const header = back ? (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Pressable testID="file-back" accessibilityRole="button" accessibilityLabel={`Back to ${back.label}`} hitSlop={6} onPress={back.onPress} style={styles.back}>
        <Icon ios="chevron.left" android="arrow_back" size={16} color={colors.accentText} />
        <Text variant="body" numberOfLines={1} style={[styles.shrink, { color: colors.accentText }]}>{back.label}</Text>
      </Pressable>
      <Text variant="headline" numberOfLines={1} style={styles.title} accessibilityRole="header">{name}</Text>
      <View style={styles.trailing}>
        {views ?? (
          <Pressable testID="file-menu" accessibilityRole="button" accessibilityLabel="More" hitSlop={6} onPress={openMenu} style={styles.more}>
            <Icon ios="ellipsis" android="more_horiz" size={18} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>
    </View>
  ) : views ? (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <View style={styles.trailing}>{views}</View>
    </View>
  ) : null;

  let body: ReactNode = null;
  let footer: string | null = null;
  if (loading) {
    // Drawn by the skeleton below.
  } else if (viewer === 'unsized' && folder.isError) {
    body = <ErrorState title={`Couldn’t open ${name}`} error={folder.error} onRetry={() => void folder.refetch()} testID="file-size-error" />;
  } else if (viewer === 'unsized') {
    body = (
      <StateScreen
        testID="file-unsized"
        icon={{ ios: 'doc.text', android: 'description' }}
        title={`${name} stays on ${profile.label}`}
        message={`${profile.label} didn’t say how big it is, so the phone doesn’t download it. Open it there, or copy its path for an agent.`}
        actions={<>
          <Button title="Try again" variant="secondary" onPress={() => void folder.refetch()} />
          <Button title="Copy path" variant="secondary" icon={<Icon ios="doc.on.doc" android="content_copy" size={16} color={colors.text} />} onPress={copyPath} />
        </>}
      />
    );
  } else if (viewer === 'stays' || text.data?.kind === 'binary') {
    const limit = imageTypeOf(path) ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    const tooBig = size !== undefined && size > limit;
    body = (
      <StateScreen
        testID="file-stays"
        icon={{ ios: 'doc.text', android: 'description' }}
        title={tooBig ? `${name} is ${formatSize(size)}` : `${name} stays on ${profile.label}`}
        message={tooBig
          ? `Files over ${formatSize(limit)} stay on ${profile.label}. Open it there, or copy its path for an agent.`
          : `The phone shows text, Markdown and images. Open it on ${profile.label}, or copy its path for an agent.`}
        actions={<Button title="Copy path" variant="secondary" icon={<Icon ios="doc.on.doc" android="content_copy" size={16} color={colors.text} />} onPress={copyPath} />}
      />
    );
  } else if (viewer === 'image') {
    body = image.data
      ? (
        <ZoomableImage uri={`data:${imageType(path)};base64,${image.data}`} label={name} />
      )
      : <ErrorState title={`Couldn’t open ${name}`} error={image.error} onRetry={() => void image.refetch()} />;
    footer = size !== undefined ? `Image · ${formatSize(size)}` : 'Image';
  } else if (text.data?.kind === 'text') {
    const content = text.data.content;
    body = markdown && !source ? <MarkdownView content={content} /> : <CodeView content={content} language={language.id} />;
    footer = [markdown ? 'Markdown' : language.label, markdown ? null : `${content.split('\n').length} lines`, size !== undefined ? formatSize(size) : null].filter(Boolean).join(' · ');
  } else {
    body = <ErrorState title={`Couldn’t open ${name}`} error={text.error} onRetry={() => void text.refetch()} />;
  }

  return (
    <View testID="file-viewer" style={[styles.fill, { backgroundColor: colors.background }]}>
      {header}
      <View style={styles.fill}>
        <SkeletonSwap loading={loading} skeleton={<FileSkeleton viewer={viewer} />} style={styles.fill}>{body}</SkeletonSwap>
      </View>
      {footer ? <TabFooter left={footer} right="Read-only" /> : null}
    </View>
  );
}

/** A file's footprint while it loads: the image's frame, Markdown's paragraphs, or numbered code lines. */
function FileSkeleton({ viewer }: { viewer: ReturnType<typeof fileViewer> }) {
  if (viewer === 'image') {
    // The image's frame fills the tab; `flex` sizes the bone over its height.
    return (
      <View testID="file-skeleton" accessible accessibilityLabel="Loading the image" style={styles.fill}>
        <Skeleton height={0} radius={0} style={styles.fill} />
      </View>
    );
  }
  if (viewer === 'markdown') {
    return (
      <View testID="file-skeleton" accessible accessibilityLabel="Loading the file" style={[styles.markdown, styles.markdownBones]}>
        <Skeleton width="55%" height={22} />
        {[[1, 0.9, 0.6], [0.95, 1, 0.8, 0.4]].map(lines => (
          <View key={lines.join()}>
            {lines.map((width, index) => <View key={index} style={styles.markdownLine}><Skeleton width={`${width * 100}%`} height={14} /></View>)}
          </View>
        ))}
      </View>
    );
  }
  return (
    <View testID="file-skeleton" accessible accessibilityLabel="Loading the file" style={styles.code}>
      {[0.45, 0.7, 0.6, 0.85, 0.3, 0.75, 0.55, 0.8, 0.4, 0.65, 0.5, 0.7].map((width, index) => (
        <View key={index} style={[styles.line, styles.codeBone]}>
          <View style={styles.codeNumber}><Skeleton width={12} height={10} /></View>
          <Skeleton width={`${width * 80}%`} height={12} />
        </View>
      ))}
    </View>
  );
}

const MAX_ZOOM = 6;

/** An image to pinch: two fingers zoom and move it, and a double tap fits it again. */
function ZoomableImage({ uri, label }: { uri: string; label: string }) {
  const { colors } = useTheme();
  const scale = useSharedValue(1);
  const startScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const pinch = Gesture.Pinch()
    .onStart(() => { startScale.value = scale.value; })
    .onUpdate(event => { scale.value = Math.min(MAX_ZOOM, Math.max(1, startScale.value * event.scale)); })
    .onEnd(() => {
      if (scale.value > 1) return;
      x.value = withTiming(0);
      y.value = withTiming(0);
    });
  // Two fingers, so a one-finger swipe still moves between tabs.
  const pan = Gesture.Pan()
    .minPointers(2)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate(event => {
      if (scale.value <= 1) return;
      x.value = startX.value + event.translationX;
      y.value = startY.value + event.translationY;
    });
  const fit = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = withTiming(1);
      x.value = withTiming(0);
      y.value = withTiming(0);
    });
  const zoomed = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));
  return (
    <GestureDetector gesture={Gesture.Race(fit, Gesture.Simultaneous(pinch, pan))}>
      <View testID="file-image" collapsable={false} style={[styles.imageContent, { backgroundColor: colors.surfaceRaised }]}>
        <Animated.View style={[styles.imageFrame, zoomed]}>
          <Image source={{ uri }} resizeMode="contain" style={styles.image} accessibilityLabel={label} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

function CodeView({ content, language }: { content: string; language: Parameters<typeof highlightLines>[1] }) {
  const theme = useTheme();
  const lines = highlightLines(content, language);
  const gutter = String(lines.length).length;
  return (
    <LegendList
      testID="file-code"
      data={lines}
      keyExtractor={(_line, index) => String(index)}
      estimatedItemSize={20}
      recycleItems
      contentContainerStyle={styles.code}
      renderItem={({ item, index }) => (
        <View style={styles.line}>
          <Text style={[styles.mono, styles.number, { width: gutter * 8.5 + 4, color: theme.colors.textMuted }]}>{index + 1}</Text>
          <Text selectable style={[styles.mono, styles.shrink, { color: theme.colors.text }]}>
            {item.map((token: Token, at: number) => (
              <Text key={at} style={token.scope && theme.syntax[token.scope] ? { color: theme.syntax[token.scope] } : undefined}>{token.text}</Text>
            ))}
          </Text>
        </View>
      )}
    />
  );
}

function MarkdownView({ content }: { content: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const renderer = useLinkRenderer();
  const rendered = useMarkdown(content, { colorScheme: theme.scheme, renderer, styles: {
    text: { color: colors.text, fontSize: 16 * theme.uiScale, lineHeight: 26 * theme.uiScale },
    link: { color: colors.accentText },
    codespan: { color: colors.text, backgroundColor: colors.surfaceRaised, fontFamily: monoFontFamily, fontStyle: 'normal' },
    code: { backgroundColor: colors.surfaceRaised, borderRadius: 8, padding: 10 },
    codeText: { color: colors.text, fontSize: 13 * theme.uiScale, fontFamily: monoFontFamily },
    paragraph: { marginTop: 0, marginBottom: 12 },
    h1: { color: colors.text },
    h2: { color: colors.text },
    h3: { color: colors.text },
  } });
  return <ScrollView testID="file-markdown" contentContainerStyle={styles.markdown}>{rendered}</ScrollView>;
}

function imageTypeOf(path: string): boolean {
  return filePreviewKind(path) === 'image';
}

function imageType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'jpg') return 'image/jpeg';
  return `image/${ext ?? 'png'}`;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  shrink: { flexShrink: 1 },
  header: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderBottomWidth: 1 },
  back: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  title: { flexShrink: 1, textAlign: 'center', maxWidth: '45%' },
  trailing: { flex: 1, alignItems: 'flex-end' },
  more: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  segments: { flexDirection: 'row', padding: 2 },
  segment: { paddingHorizontal: 10, paddingVertical: 4 },
  code: { paddingVertical: 8, paddingRight: 12 },
  line: { flexDirection: 'row', gap: 10 },
  mono: { fontFamily: monoFontFamily, fontSize: 13, lineHeight: 20 },
  number: { textAlign: 'right' },
  markdown: { padding: 16 },
  // Bones keep the lines' heights: code 20 pt, Markdown text 26 with 12 between paragraphs.
  codeBone: { height: 20, alignItems: 'center' },
  codeNumber: { width: 21, alignItems: 'flex-end' },
  markdownBones: { gap: 12 },
  markdownLine: { height: 26, justifyContent: 'center' },
  imageContent: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  imageFrame: { width: '100%', alignItems: 'center' },
  image: { width: '100%', aspectRatio: 1 },
});
