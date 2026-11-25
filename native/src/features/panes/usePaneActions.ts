import { Alert } from 'react-native';

import { useOpenFromHome } from '@/features/layout/wideLayout';
import { useSetSessionPaused, useUpdateSession } from '@/features/sessions/hooks';

import { useArchivePane, useDeleteArchivedPane, useMarkPaneSeen, useRestorePane, useSetPanePaused, useToggleFavorite } from './hooks';

/**
 * What a Pane or Session row does on the machine the phone is on: open, pin, pause, archive,
 * restore and delete, each saying what went wrong in an alert.
 */
export function usePaneActions() {
  const markSeen = useMarkPaneSeen();
  const open = useOpenFromHome();
  const toggleFavorite = useToggleFavorite();
  const archive = useArchivePane();
  const restorePane = useRestorePane();
  const deleteArchivedPane = useDeleteArchivedPane();
  const updateSession = useUpdateSession();
  const setPanePaused = useSetPanePaused();
  const setSessionPaused = useSetSessionPaused();
  const fail = (title: string) => (error: Error) => Alert.alert(title, error.message);
  const showPauseNote = (note: string | undefined) => { if (note) Alert.alert('Chat tabs keep running', note); };

  return {
    openPane(paneId: string) {
      markSeen(paneId);
      open({ pathname: '/pane/[paneId]', params: { paneId } });
    },
    openSession(sessionId: string) {
      open({ pathname: '/session/[sessionId]', params: { sessionId } });
    },
    togglePanePinned(paneId: string) {
      toggleFavorite(paneId).catch(fail('Couldn’t update pinned panes'));
    },
    archivePane(pane: { id: string; name: string }) {
      Alert.alert(`Archive “${pane.name}”?`, 'Its agents stop and its worktree is removed. You can still find it under Archived.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Archive', style: 'destructive', onPress: () => archive(pane.id).catch(fail('Couldn’t archive the pane')) },
      ]);
    },
    setPanePaused(paneId: string, paused: boolean) {
      setPanePaused(paneId, paused).then(showPauseNote).catch(fail(paused ? 'Couldn’t pause the pane' : 'Couldn’t resume the pane'));
    },
    restorePane(paneId: string) {
      restorePane(paneId).catch(fail('Couldn’t restore the pane'));
    },
    deletePane(pane: { id: string; label: string }) {
      Alert.alert(`Delete “${pane.label}”?`, 'This removes the pane and its history from the host for good.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteArchivedPane(pane.id).catch(fail('Couldn’t delete the pane')) },
      ]);
    },
    toggleSessionPinned(sessionId: string, isPinned: boolean) {
      updateSession(sessionId, { isPinned }).catch(fail('Couldn’t update the Session pin'));
    },
    // Desktop archives Sessions without asking; Restore brings them back.
    archiveSession(sessionId: string) {
      updateSession(sessionId, { archived: true }).catch(fail('Couldn’t archive the Session'));
    },
    restoreSession(sessionId: string) {
      updateSession(sessionId, { archived: false }).catch(fail('Couldn’t restore the Session'));
    },
    setSessionPaused(sessionId: string, paused: boolean) {
      setSessionPaused(sessionId, paused).then(showPauseNote).catch(fail(paused ? 'Couldn’t pause the Session' : 'Couldn’t resume the Session'));
    },
  };
}

export type PaneActions = ReturnType<typeof usePaneActions>;
