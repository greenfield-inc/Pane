import { router, useLocalSearchParams } from 'expo-router';

import type { ToolPanel } from '@shared/types/panels';

import { useInvokeMutation } from '@/daemon';
import { createPanelRequest, NEW_PANEL_OPTIONS, type NewPanelOption } from '@/features/terminal/panels';
import { ErrorState, ListRow, ListSection, Sheet } from '@/ui';

/** Opens a new terminal tab in the pane: a shell or an agent. */
export default function NewPanelSheet() {
  const { paneId } = useLocalSearchParams<{ paneId: string }>();
  const create = useInvokeMutation<[ReturnType<typeof createPanelRequest>], ToolPanel>('panels:create', {
    invalidates: ['panels:list'],
  });
  const setActive = useInvokeMutation<[string, string]>('panels:set-active');

  const open = (option: NewPanelOption) => {
    create.mutate([createPanelRequest(paneId, option)], {
      onSuccess: panel => {
        setActive.mutate([paneId, panel.id]);
        router.dismissTo({ pathname: '/pane/[paneId]', params: { paneId, panelId: panel.id } });
      },
    });
  };

  return (
    <Sheet title="New tab" testID="new-panel-sheet">
      <ListSection>
        {NEW_PANEL_OPTIONS.map(option => (
          <ListRow
            key={option.id}
            testID={`new-panel-${option.id}`}
            title={option.title}
            subtitle={option.initialCommand ?? 'A shell in the pane’s worktree'}
            onPress={create.isPending ? undefined : () => open(option)}
          />
        ))}
      </ListSection>
      {create.isError ? <ErrorState title="Couldn’t open the tab" error={create.error} /> : null}
    </Sheet>
  );
}
