import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';

import { COMPOSER_MENU_TEXT } from '@shared/composerMentions';
import { workerLines } from '@shared/chatTabPresentation';
import type { ChatPanelState } from '@shared/types/chatTab';
import type { OrchestrationSessionOverview } from '@shared/types/orchestrationSession';
import type { ToolPanel } from '@shared/types/panels';

import { invokeChannel, useDaemon, useDaemonEvent, useInvokeQuery, useReadOnlyHost } from '@/daemon';
import { useTheme } from '@/theme';

import { decodeFolder, parentOf, posixPath } from '../files/files';
import { FileViewer } from '../files/FileViewer';
import { ChatTabScreen } from './ChatTabScreen';

/** Brings a device tab forward in the phone's tab strip. */
const openDevice = (panelId: string) => router.setParams({ panelId });

/** Opens a worker's Pane; one function for every render, so the chat's memoized rows skip. */
const openWorker = (paneId: string) => router.push({ pathname: '/pane/[paneId]', params: { paneId } });

/** The Session's workers from Pane's own overview, refreshed when their states change. */
function useSessionWorkers(sessionId: string | undefined) {
  const overview = useInvokeQuery<OrchestrationSessionOverview>('orchestration-sessions:overview', [{ sessionId: sessionId ?? '' }], { enabled: !!sessionId });
  useDaemonEvent('orchestration-sessions:overview-updated', () => { if (sessionId) void overview.refetch(); });
  if (!overview.data) return undefined;
  const attached = new Map(overview.data.session.associations.map(association => [association.paneId, association.attachedAt]));
  return workerLines(overview.data.panes, attached);
}

/**
 * A chat tab in the phone's tab strip. The Session orchestrator's chat
 * lists its workers, each opening its Pane (D-18, D-19).
 */
export function ChatTabBody({ panel, panels }: { panel: ToolPanel; panels: readonly ToolPanel[] }) {
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  const state = panel.state.customState as ChatPanelState | undefined;
  const sessionId = state?.orchestrationSessionId;
  const readOnly = useReadOnlyHost();
  const workers = useSessionWorkers(sessionId);
  const diffId = panels.find(candidate => candidate.type === 'diff')?.id;
  const viewDiff = useCallback(() => router.setParams({ panelId: diffId }), [diffId]);
  const { client } = useDaemon();
  const theme = useTheme();
  const [file, setFile] = useState<{ path: string; size?: number }>();
  const close = useCallback(() => setFile(undefined), []);
  useEffect(() => {
    if (!file) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    return () => back.remove();
  }, [file, close]);
  const paneId = panel.sessionId;
  const cwd = state?.cwd;
  const openFile = useCallback(async (reference: string) => {
    try {
      const pane = await invokeChannel<{ worktreePath?: string }>(client, 'sessions:get', [paneId]);
      const path = underPane(reference, cwd, pane.worktreePath);
      const entry = path === undefined ? undefined : decodeFolder(await client.invoke('file:list', [{ sessionId: paneId, path: parentOf(path) }])).find(item => item.path === path);
      if (!entry) return COMPOSER_MENU_TEXT.fileGone;
      if (!entry.isDirectory) setFile({ path: entry.path, size: entry.size });
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return /ENOENT|no such file|not found|Invalid path|outside/i.test(reason) ? COMPOSER_MENU_TEXT.fileGone : reason;
    }
  }, [client, paneId, cwd]);
  // The chat stays mounted under the file, so its draft, images and reading place are kept.
  return <View style={styles.fill}>
    <View style={styles.fill} accessibilityElementsHidden={!!file} importantForAccessibility={file ? 'no-hide-descendants' : 'auto'}>
      <ChatTabScreen key={panel.id} panelId={panel.id} workers={workers}
        session={!!sessionId}
        onOpenFile={readOnly ? undefined : openFile}
        onOpenWorker={openWorker}
        onOpenDevice={readOnly ? undefined : openDevice}
        onViewDiff={diffId ? viewDiff : undefined} />
    </View>
    {file && <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.background }]}>
      <FileViewer key={file.path} sessionId={paneId} path={file.path} size={file.size} back={{ label: 'Chat', onPress: close }} />
    </View>}
  </View>;
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });

/** A path under the tab's folder, as one under its Pane's; undefined when it leaves the Pane. */
function underPane(reference: string, cwd: string | undefined, pane: string | undefined): string | undefined {
  const path = posixPath(reference);
  const folder = posixPath(cwd ?? '').replace(/\/+$/, '');
  const root = posixPath(pane ?? '').replace(/\/+$/, '');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return undefined;
  // A tab runs in its Pane's folder, or in one below it.
  const prefix = folder && root && folder.startsWith(`${root}/`) ? folder.slice(root.length + 1).split('/') : [];
  const parts: string[] = [];
  for (const part of [...prefix, ...path.split('/')]) {
    if (part === '..') { if (!parts.length) return undefined; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.length ? parts.join('/') : undefined;
}
