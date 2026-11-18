import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, SkeletonSwap } from '@/ui';

import { LoadingRows, Notice, SectionHeader } from './PaneKit';
import type { SidebarItem, SidebarSection } from './paneList';
import { PaneRow } from './PaneRow';
import { ArchivedRow, SessionRow, SidebarNote, SidebarSectionHeader } from './SidebarRows';
import type { PaneActions } from './usePaneActions';

export interface SidebarItemContext {
  actions: PaneActions;
  /** Approvals waiting from a Session on this machine. */
  waitingFor: (sessionId: string) => number;
  onToggleSection: (section: SidebarSection) => void;
  onToggleNested: (nestedKey: string) => void;
  retry: (what: 'sessions' | 'archived') => void;
  /** What rows sit on: the page, or a card. */
  background?: string;
}

/** One row of the Pinned, Sessions, Repositories and Archived lists (`buildSidebar`). */
export function SidebarItemView({ item, previous, first, context }: {
  item: SidebarItem;
  previous: SidebarItem | undefined;
  /** The list's first row sits flush with its top. */
  first: boolean;
  context: SidebarItemContext;
}) {
  const theme = useTheme();
  const { actions, background } = context;
  switch (item.type) {
    case 'section':
      return <SidebarSectionHeader item={item} first={first} onToggle={() => context.onToggleSection(item.section)} />;
    case 'repo':
      return (
        <SectionHeader
          title={item.title}
          // Flush under the Repositories header or the top of the list, spaced after that.
          first={first || previous?.type === 'section'}
          icon={<Icon ios="folder" android="folder" size={14} />}
          add={{
            label: `New pane in ${item.title}`,
            testID: `panes-new-${item.projectId}`,
            onPress: () => router.push({ pathname: '/new', params: { kind: 'pane', projectId: String(item.projectId) } }),
          }}
        />
      );
    case 'pane':
      return (
        <View style={item.nested ? [styles.nested, { borderColor: theme.colors.border }] : undefined}>
          <PaneRow
            pane={item.pane}
            label={item.label}
            background={background}
            onOpen={() => actions.openPane(item.pane.id)}
            onTogglePinned={() => actions.togglePanePinned(item.pane.id)}
            onArchive={() => actions.archivePane(item.pane)}
            onTogglePaused={() => actions.setPanePaused(item.pane.id, !item.pane.paused)}
          />
        </View>
      );
    case 'session':
      return (
        <SessionRow
          item={item}
          background={background}
          waiting={context.waitingFor(item.session.id)}
          onOpen={() => actions.openSession(item.session.id)}
          onToggleNested={() => context.onToggleNested(item.nestedKey)}
          onTogglePinned={() => actions.toggleSessionPinned(item.session.id, !item.session.isPinned)}
          onArchive={() => actions.archiveSession(item.session.id)}
          onTogglePaused={() => actions.setSessionPaused(item.session.id, !item.session.paused)}
        />
      );
    case 'archived':
      return item.kind === 'session'
        ? <ArchivedRow item={item} onRestore={() => actions.restoreSession(item.id)} />
        : <ArchivedRow item={item} onRestore={() => actions.restorePane(item.id)} onDelete={() => actions.deletePane(item)} />;
    case 'loading':
      return <SkeletonSwap loading skeleton={<LoadingRows archived />}>{null}</SkeletonSwap>;
    case 'note':
      return item.danger
        ? <Notice danger message={item.text} action={{ title: 'Try again', onPress: () => context.retry(item.retry ?? 'sessions') }} />
        : <SidebarNote testID={item.key} text={item.text} />;
  }
}

/** Shows or hides one Session row's nested panes. */
export function toggleMember(current: ReadonlySet<string>, member: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(member)) next.delete(member);
  else next.add(member);
  return next;
}

const styles = StyleSheet.create({
  // ml-5 border-l pl-2 under the Session row.
  nested: { marginLeft: 20, paddingLeft: 8, borderLeftWidth: 1 },
});
