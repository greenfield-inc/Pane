import { LegendList } from '@legendapp/list/react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import type { ChangedFileSummary } from '@shared/types/gitDiff';
import type { ToolPanel } from '@shared/types/panels';

import { useTheme } from '@/theme';
import { EmptyState, ErrorState, Icon, Text } from '@/ui';

import { ChangeBadge } from '../diff/DiffTab';
import { useChanges } from '../diff/useDiff';
import { FileViewer } from './FileViewer';
import { formatSize, parentOf, pathCrumbs, type FileEntry } from './files';
import { useFileSearch, useFolder } from './useFiles';

/** How long typing pauses before Explorer searches the worktree. */
const SEARCH_DELAY_MS = 250;

// Switching tabs unmounts Explorer; this keeps each tab's folder and open file until the app closes.
const places = new Map<string, Place>();
interface Place {
  folder: string;
  file: FileEntry | null;
}

/**
 * The worktree, one folder at a time: a path bar back up, a search box, then folders and files.
 * A file opens in the read-only viewer, with a row back to its folder.
 */
export function ExplorerTab({ panel, rootName }: { panel: ToolPanel; rootName: string }) {
  const [place, setPlace] = useState<Place>(() => places.get(panel.id) ?? { folder: '', file: null });
  const go = (next: Place) => {
    places.set(panel.id, next);
    setPlace(next);
  };
  if (place.file) {
    const folderName = place.folder.split('/').pop() || rootName;
    return (
      <FileViewer
        key={place.file.path}
        sessionId={panel.sessionId}
        path={place.file.path}
        size={place.file.size}
        back={{ label: folderName, onPress: () => go({ ...place, file: null }) }}
      />
    );
  }
  return (
    <FolderView
      sessionId={panel.sessionId}
      rootName={rootName}
      folder={place.folder}
      onOpenFolder={folder => go({ folder, file: null })}
      onOpenFile={file => go({ folder: parentOf(file.path), file })}
    />
  );
}

function FolderView({ sessionId, rootName, folder, onOpenFolder, onOpenFile }: {
  sessionId: string;
  rootName: string;
  folder: string;
  onOpenFolder: (path: string) => void;
  onOpenFile: (file: FileEntry) => void;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const [query, setQuery] = useState('');
  const [pattern, setPattern] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setPattern(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const entries = useFolder(sessionId, folder);
  // The branch's changes: listed first at the top, and marked on their rows. An older computer or a
  // failed read just leaves them out.
  const changes = useChanges(sessionId);
  const changed = new Map((changes.data?.files ?? []).map(file => [file.path, file]));
  const search = useFileSearch(sessionId, pattern);
  const searching = pattern.length > 0;
  const list = searching ? search : entries;
  const crumbs = pathCrumbs(rootName, folder);

  const open = (entry: FileEntry) => {
    setQuery('');
    setPattern('');
    if (entry.isDirectory) onOpenFolder(entry.path);
    else onOpenFile(entry);
  };

  return (
    <View testID="explorer-tab" style={[styles.fill, { backgroundColor: colors.background }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.crumbBar} contentContainerStyle={styles.crumbs} accessibilityRole="toolbar">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <View key={crumb.path} style={styles.crumb}>
              {index > 0 ? <Icon ios="chevron.right" android="chevron_right" size={11} color={colors.textMuted} /> : null}
              <Pressable
                testID={`explorer-crumb-${crumb.path || 'root'}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: last }}
                disabled={last}
                hitSlop={6}
                onPress={() => onOpenFolder(crumb.path)}
              >
                <Text variant="subhead" tone={last ? 'primary' : 'secondary'} style={last ? styles.semibold : undefined}>{crumb.name}</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
      <View style={[styles.search, { borderRadius: theme.radius.lg, backgroundColor: colors.surfaceRaised }]}>
        <Icon ios="magnifyingglass" android="search" size={16} color={colors.textMuted} />
        <TextInput
          testID="explorer-search"
          accessibilityLabel="Search files"
          placeholder="Search files"
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={[theme.typography.body, styles.searchInput, { color: colors.text }]}
        />
      </View>
      {list.isPending ? (
        <View style={styles.center}><ActivityIndicator color={colors.textMuted} /></View>
      ) : list.isError ? (
        <ErrorState title={searching ? 'Search didn’t finish' : 'Couldn’t open this folder'} error={list.error} onRetry={() => void list.refetch()} testID="explorer-error" />
      ) : list.data.length === 0 ? (
        <EmptyState testID="explorer-empty" title={searching ? 'No matches' : 'Empty folder'} message={searching ? `No file name in ${rootName} contains “${pattern}”.` : undefined} />
      ) : (
        <LegendList
          testID="explorer-list"
          data={list.data}
          keyExtractor={entry => entry.path}
          estimatedItemSize={46}
          recycleItems
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          refreshing={list.isRefetching}
          onRefresh={() => void list.refetch()}
          ListHeaderComponent={!searching && folder === '' && changed.size > 0 ? (
            <View>
              <SectionLabel text={`Changed on this branch · ${changed.size}`} />
              {[...changed.values()].map(file => (
                <ChangedRow key={file.path} file={file} onPress={() => open({ name: file.path.split('/').pop() ?? file.path, path: file.path, isDirectory: false })} />
              ))}
              <SectionLabel text="All files" />
            </View>
          ) : undefined}
          renderItem={({ item }) => <EntryRow entry={item} change={changed.get(item.path)} showFolder={searching} onPress={() => open(item)} />}
        />
      )}
    </View>
  );
}

function SectionLabel({ text }: { text: string }) {
  return <Text variant="caption" tone="muted" style={styles.section}>{text.toUpperCase()}</Text>;
}

function ChangedRow({ file, onPress }: { file: ChangedFileSummary; onPress: () => void }) {
  const { colors } = useTheme();
  const name = file.path.split('/').pop() ?? file.path;
  const deleted = file.kind === 'deleted';
  return (
    <Pressable
      testID={`explorer-changed-${file.path}`}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${file.kind}`}
      accessibilityState={{ disabled: deleted }}
      disabled={deleted}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
    >
      <ChangeBadge file={file} />
      <View style={[styles.rowBody, { borderBottomColor: colors.border }]}>
        <Text variant="body" numberOfLines={1} style={[styles.name, deleted && { color: colors.textMuted }]}>{name}</Text>
        <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.detail}>{parentOf(file.path)}</Text>
      </View>
    </Pressable>
  );
}

function EntryRow({ entry, change, showFolder, onPress }: { entry: FileEntry; change?: ChangedFileSummary; showFolder: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const icon = entry.isDirectory
    ? { ios: 'folder', android: 'folder' } as const
    : /\.(md|markdown)$/i.test(entry.name) ? { ios: 'doc.richtext', android: 'article' } as const : { ios: 'doc.text', android: 'description' } as const;
  const folder = parentOf(entry.path);
  return (
    <Pressable
      testID={`explorer-row-${entry.path}`}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${entry.isDirectory ? 'folder' : 'file'}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
    >
      <Icon ios={icon.ios} android={icon.android} size={20} color={entry.isDirectory ? colors.accent : colors.textSecondary} />
      <View style={[styles.rowBody, { borderBottomColor: colors.border }]}>
        <Text variant="body" numberOfLines={1} style={styles.name}>{entry.name}</Text>
        {showFolder && folder ? <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.detail}>{folder}</Text> : null}
        {change ? <ChangeBadge file={change} /> : null}
        {!showFolder && entry.size !== undefined ? <Text variant="footnote" tone="muted">{formatSize(entry.size)}</Text> : null}
        {entry.isDirectory ? <Icon ios="chevron.right" android="chevron_right" size={13} color={colors.textMuted} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  shrink: { flexShrink: 1 },
  semibold: { fontWeight: '600' },
  crumbBar: { flexGrow: 0 },
  crumbs: { alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  crumb: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, height: 40 },
  searchInput: { flex: 1, padding: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 16, minHeight: 46 },
  rowBody: { flex: 1, minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  name: { flex: 1 },
  section: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, letterSpacing: 0.4 },
  detail: { flexShrink: 1, maxWidth: '45%' },
});
