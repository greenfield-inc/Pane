import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import type { ChatTabCreate } from '@shared/types/chatTab';
import type { ToolPanel } from '@shared/types/panels';

import { useInvokeMutation } from '@/daemon';
import { createPanelRequest, newPanelOptions, type NewPanelOption } from '@/features/terminal/panels';
import { useAffordances } from '@/features/hosts/hostSettings';
import { useTheme } from '@/theme';
import { ErrorState, Icon, Sheet, Text } from '@/ui';

// Stand-ins for the web app's brand icons, which have no system symbol.
const ICONS: Record<string, { ios: SFSymbol; android: AndroidSymbol }> = {
  claude: { ios: 'asterisk', android: 'asterisk' },
  codex: { ios: 'hexagon', android: 'hexagon' },
  cursor: { ios: 'cube', android: 'deployed_code' },
};
const TERMINAL_ICON = { ios: 'apple.terminal', android: 'terminal' } as const;

/** The web app's Add tool menu: opens a new terminal tab in the pane, a shell or an agent. */
export default function NewPanelSheet() {
  // `sessionId` when the pane is a Session's workspace: the new tab opens back in the Session.
  const { paneId, sessionId } = useLocalSearchParams<{ paneId: string; sessionId?: string }>();
  const theme = useTheme();
  const { colors } = theme;
  const affordances = useAffordances();
  const create = useInvokeMutation<[ReturnType<typeof createPanelRequest>], ToolPanel>('panels:create', {
    invalidates: ['panels:list'],
  });
  const createChat = useInvokeMutation<[ChatTabCreate], { panelId: string }>('chat-tab:create', { invalidates: ['panels:list'] });
  const setActive = useInvokeMutation<[string, string]>('panels:set-active');
  const pending = create.isPending || createChat.isPending;

  const opened = (panelId: string) => {
    setActive.mutate([paneId, panelId]);
    if (sessionId) router.dismissTo({ pathname: '/session/[sessionId]', params: { sessionId, panelId } });
    else router.dismissTo({ pathname: '/pane/[paneId]', params: { paneId, panelId } });
  };
  const open = (option: NewPanelOption) => {
    if (option.chat) {
      createChat.mutate([{ sessionId: paneId, agent: option.chat }], { onSuccess: result => opened(result.panelId) });
      return;
    }
    create.mutate([createPanelRequest(paneId, option)], { onSuccess: panel => opened(panel.id) });
  };

  return (
    <Sheet title="Add tool" testID="new-panel-sheet">
      <View style={[styles.menu, { borderRadius: theme.radius.lg, borderColor: colors.border, backgroundColor: colors.surface }]}>
        {newPanelOptions(affordances.data?.customCommands ?? [], affordances.data?.chatTabsEnabled === true).map(option => {
          const icon = ICONS[option.chat ?? option.id] ?? TERMINAL_ICON;
          return (
            <Pressable
              key={option.id}
              testID={`new-panel-${option.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${option.title}, ${option.description}`}
              accessibilityState={{ disabled: pending }}
              disabled={pending}
              onPress={() => open(option)}
              android_ripple={{ color: colors.surfacePressed }}
              style={({ pressed }) => [styles.item, { backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
            >
              <View style={styles.icon}>
                <Icon ios={icon.ios} android={icon.android} size={16} color={colors.textMuted} />
              </View>
              <View style={styles.body}>
                <Text variant="callout">{option.title}</Text>
                <Text variant="footnote" tone="muted" numberOfLines={1}>{option.description}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {create.isError ? <ErrorState title="Couldn’t open the tab" error={create.error} /> : null}
      {createChat.isError ? <ErrorState title="Couldn’t open the chat" error={createChat.error} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  menu: { overflow: 'hidden', borderWidth: 1 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  icon: { marginTop: 2 },
  body: { flex: 1, minWidth: 0 },
});
