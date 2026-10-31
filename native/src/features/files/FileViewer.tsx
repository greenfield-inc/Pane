import { LegendList } from '@legendapp/list/react-native';
import * as Clipboard from 'expo-clipboard';
import { useState, type ReactNode } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Image, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import { filePreviewKind } from '@shared/utils/filePreview';

import { useDaemon } from '@/daemon';
import { monoFontFamily, useTheme } from '@/theme';
import { Button, ErrorState, Icon, Text } from '@/ui';

import { StateScreen } from '../tabs/StateScreen';
import { fileViewer, formatSize, highlightLines, languageOf, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, parentOf, type Token } from './files';
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
export function FileViewer({ sessionId, path, size: knownSize, back }: FileViewerProps) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const name = path.split('/').pop() ?? path;
  const folder = useFolder(sessionId, parentOf(path), knownSize === undefined);
  const size = knownSize ?? folder.data?.find(entry => entry.path === path)?.size;
  const sizeKnown = knownSize !== undefined || !folder.isPending;
  const viewer = fileViewer(path, size);
  const text = useFileText(sessionId, path, sizeKnown && (viewer === 'code' || viewer === 'markdown'));
  const image = useFileBinary(sessionId, path, sizeKnown && viewer === 'image');
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

  const markdown = viewer === 'markdown' && text.data?.kind === 'text';
  const header = back ? (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Pressable testID="file-back" accessibilityRole="button" accessibilityLabel={`Back to ${back.label}`} hitSlop={6} onPress={back.onPress} style={styles.back}>
        <Icon ios="chevron.left" android="arrow_back" size={16} color={colors.accentText} />
        <Text variant="body" numberOfLines={1} style={[styles.shrink, { color: colors.accentText }]}>{back.label}</Text>
      </Pressable>
      <Text variant="headline" numberOfLines={1} style={styles.title} accessibilityRole="header">{name}</Text>
      <View style={styles.trailing}>
        {markdown ? (
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
        ) : (
          <Pressable testID="file-menu" accessibilityRole="button" accessibilityLabel="More" hitSlop={6} onPress={openMenu} style={styles.more}>
            <Icon ios="ellipsis" android="more_horiz" size={18} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>
    </View>
  ) : null;

  let body: ReactNode;
  let footer: string | null = null;
  if (!sizeKnown || (viewer === 'image' ? image.isPending : viewer !== 'stays' && text.isPending)) {
    body = <View style={styles.center}><ActivityIndicator color={colors.textMuted} /></View>;
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
        <ScrollView testID="file-image" maximumZoomScale={6} minimumZoomScale={1} centerContent contentContainerStyle={styles.imageContent} style={{ backgroundColor: colors.surfaceRaised }}>
          <Image source={{ uri: `data:${imageType(path)};base64,${image.data}` }} resizeMode="contain" style={styles.image} accessibilityLabel={name} />
        </ScrollView>
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
      <View style={styles.fill}>{body}</View>
      {footer ? (
        <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
          <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>{footer}</Text>
          <Text variant="footnote" tone="muted">Read-only</Text>
        </View>
      ) : null}
    </View>
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
  const rendered = useMarkdown(content, { colorScheme: theme.scheme, styles: {
    text: { color: colors.text, fontSize: 16, lineHeight: 26 },
    link: { color: colors.accentText },
    codespan: { color: colors.text, backgroundColor: colors.surfaceRaised, fontFamily: monoFontFamily, fontStyle: 'normal' },
    code: { backgroundColor: colors.surfaceRaised, borderRadius: 8, padding: 10 },
    codeText: { color: colors.text, fontSize: 13, fontFamily: monoFontFamily },
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  imageContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', aspectRatio: 1 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1 },
});
