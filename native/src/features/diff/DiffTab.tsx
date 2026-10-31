import { LegendList } from '@legendapp/list/react-native';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { ChangedFileSummary, DiffScope } from '@shared/types/gitDiff';
import type { EditorPanelState, ToolPanel } from '@shared/types/panels';

import { useDaemon } from '@/daemon';
import { monoFontFamily, useTheme, withAlpha } from '@/theme';
import { EmptyState, ErrorState, Icon, Text } from '@/ui';

import { changeBadge, DiffError, parsePatch, versusLabel, type PatchRow } from './diff';
import { BRANCH_SCOPE, useChanges, useFileDiff } from './useDiff';

/** The branch's changes, read-only: each file with its counts, tapped open to its patch. */
export function DiffTab({ panel }: { panel: ToolPanel }) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const changes = useChanges(panel.sessionId);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (path: string) => setOpen(current => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  let body;
  if (changes.isPending) body = <View style={styles.center}><ActivityIndicator color={colors.textMuted} /></View>;
  else if (changes.isError) body = <ErrorState title="Couldn’t read this branch’s changes" error={changes.error} onRetry={() => void changes.refetch()} testID="diff-error" />;
  else if (changes.data.files.length === 0) body = <EmptyState testID="diff-empty" title="No changes" message={`This branch matches ${versusLabel(changes.data.resolvedBase).replace(/^vs /, '') || 'its base'}.`} />;
  else {
    const { stats } = changes.data;
    body = (
      <>
        <View style={[styles.summary, { borderBottomColor: colors.border }]}>
          <Text variant="callout" style={styles.semibold}>{stats.filesChanged} {stats.filesChanged === 1 ? 'file' : 'files'}</Text>
          <Counts additions={stats.additions} deletions={stats.deletions} />
          <Text variant="subhead" tone="muted" style={styles.versus}>{versusLabel(changes.data.resolvedBase)}</Text>
        </View>
        <LegendList
          testID="diff-list"
          data={changes.data.files}
          keyExtractor={file => file.path}
          estimatedItemSize={48}
          extraData={open}
          refreshing={changes.isRefetching}
          onRefresh={() => void changes.refetch()}
          renderItem={({ item }) => (
            <View style={[styles.file, { borderBottomColor: colors.border }]}>
              <Pressable
                testID={`diff-file-${item.path}`}
                accessibilityRole="button"
                accessibilityState={{ expanded: open.has(item.path) }}
                onPress={() => toggle(item.path)}
                style={({ pressed }) => [styles.fileRow, pressed && { backgroundColor: colors.surfacePressed }]}
              >
                <Icon ios={open.has(item.path) ? 'chevron.down' : 'chevron.right'} android={open.has(item.path) ? 'expand_more' : 'chevron_right'} size={12} color={colors.textMuted} />
                <ChangeBadge file={item} />
                <FilePath path={item.path} />
                <Counts additions={item.additions} deletions={item.deletions} />
              </Pressable>
              {open.has(item.path) ? <FilePatch sessionId={panel.sessionId} scope={BRANCH_SCOPE} file={item} /> : null}
            </View>
          )}
        />
      </>
    );
  }
  return (
    <View testID="diff-tab" style={[styles.fill, { backgroundColor: colors.background }]}>
      <View style={styles.fill}>{body}</View>
      <ReadOnlyFooter left="Read-only on the phone" right={`Commit and revert on ${profile.label}`} />
    </View>
  );
}

/** An Editor tab showing one file's changes: its patch, read-only. */
export function DiffEditorTab({ panel }: { panel: ToolPanel }) {
  const { colors } = useTheme();
  const { profile } = useDaemon();
  const state = panel.state.customState as EditorPanelState;
  const scope: DiffScope = state.diff?.scope ?? BRANCH_SCOPE;
  return (
    <View testID="diff-editor-tab" style={[styles.fill, { backgroundColor: colors.background }]}>
      <View style={styles.fill}>
        <FilePatch sessionId={panel.sessionId} scope={scope} file={{ path: state.filePath, previousPath: state.diff?.previousPath }} fill />
      </View>
      <ReadOnlyFooter left="Read-only on the phone" right={`Commit and revert on ${profile.label}`} />
    </View>
  );
}

function FilePatch({ sessionId, scope, file, fill }: {
  sessionId: string;
  scope: DiffScope;
  file: Pick<ChangedFileSummary, 'path' | 'previousPath'>;
  /** Fills the tab and scrolls on its own, instead of sitting inside the file list. */
  fill?: boolean;
}) {
  const { colors } = useTheme();
  const diff = useFileDiff(sessionId, scope, file.previousPath ? { path: file.path, previousPath: file.previousPath } : { path: file.path });
  if (diff.isPending) return <View style={[styles.patchState, fill && styles.center]}><ActivityIndicator color={colors.textMuted} /></View>;
  if (diff.isError) {
    const tooLarge = diff.error instanceof DiffError && diff.error.code === 'diff-too-large';
    return (
      <View testID="diff-patch-error" style={[styles.patchState, fill && styles.center]}>
        <Text variant="subhead" tone="secondary" style={styles.centerText}>
          {tooLarge ? 'This patch is too large for the phone. Open it on the computer.' : diff.error.message}
        </Text>
      </View>
    );
  }
  if (diff.data.status === 'no-longer-changed') {
    return <View style={[styles.patchState, fill && styles.center]}><Text variant="subhead" tone="secondary">This file no longer has changes.</Text></View>;
  }
  const rows = parsePatch(diff.data.patch);
  if (rows.length === 0) {
    return <View style={[styles.patchState, fill && styles.center]}><Text variant="subhead" tone="secondary">No text changes (a binary file, or only its mode changed).</Text></View>;
  }
  if (fill) {
    return (
      <LegendList
        testID="diff-patch"
        data={rows}
        keyExtractor={(_row, index) => String(index)}
        estimatedItemSize={20}
        recycleItems
        renderItem={({ item }) => <PatchLine row={item} />}
      />
    );
  }
  return <View testID="diff-patch" style={styles.patch}>{rows.map((row, index) => <PatchLine key={index} row={row} />)}</View>;
}

function PatchLine({ row }: { row: PatchRow }) {
  const { colors } = useTheme();
  const background = row.kind === 'added' ? withAlpha(colors.success, 0.14)
    : row.kind === 'removed' ? withAlpha(colors.danger, 0.12)
      : row.kind === 'hunk' ? colors.surfaceRaised : 'transparent';
  const color = row.kind === 'removed' ? colors.danger : row.kind === 'hunk' || row.kind === 'note' ? colors.textMuted : colors.text;
  return <Text selectable style={[styles.mono, styles.patchLine, { backgroundColor: background, color }]}>{row.text || ' '}</Text>;
}

/** The change's letter in a tinted box: M amber, A green, D red. */
export function ChangeBadge({ file }: { file: Pick<ChangedFileSummary, 'kind'> }) {
  const theme = useTheme();
  const tone = file.kind === 'added' ? theme.colors.success : file.kind === 'deleted' ? theme.colors.danger : theme.colors.warning;
  return (
    <View style={[styles.badge, { borderRadius: theme.radius.sm, backgroundColor: withAlpha(tone, 0.15) }]}>
      <Text style={[styles.mono, styles.badgeText, { color: tone }]}>{changeBadge(file.kind)}</Text>
    </View>
  );
}

function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  return (
    <Text variant="subhead" numberOfLines={1} ellipsizeMode="head" style={styles.path}>
      {slash >= 0 ? <Text variant="subhead" tone="muted">{path.slice(0, slash + 1)}</Text> : null}
      {path.slice(slash + 1)}
    </Text>
  );
}

function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  const { colors } = useTheme();
  return (
    <View style={styles.counts}>
      {additions ? <Text variant="callout" style={{ color: colors.success }}>+{additions}</Text> : null}
      {deletions ? <Text variant="callout" style={{ color: colors.danger }}>−{deletions}</Text> : null}
    </View>
  );
}

export function ReadOnlyFooter({ left, right }: { left: string; right: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
      <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>{left}</Text>
      <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>{right}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },
  shrink: { flexShrink: 1 },
  semibold: { fontWeight: '600' },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  versus: { marginLeft: 'auto' },
  file: { borderBottomWidth: StyleSheet.hairlineWidth },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, minHeight: 48 },
  path: { flex: 1 },
  counts: { flexDirection: 'row', gap: 8 },
  badge: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  mono: { fontFamily: monoFontFamily },
  patch: { paddingBottom: 4 },
  patchLine: { fontSize: 13, lineHeight: 20, paddingHorizontal: 10 },
  patchState: { padding: 16 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1 },
});
