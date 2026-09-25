import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import type { ToolPanel } from '@shared/types/panels';
import type { RemotePwaAffordances } from '@shared/types/remoteDaemon';

import { useInvokeMutation, useInvokeQuery } from '@/daemon';
import { createPanelRequest, newPanelOptions, type NewPanelOption } from '@/features/terminal/panels';
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
  const { paneId } = useLocalSearchParams<{ paneId: string }>();
  const theme = useTheme();
  const { colors } = theme;
  const affordances = useInvokeQuery<RemotePwaAffordances>('remote:pwa-affordances', [], { staleTime: 5 * 60_000 });
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
    <Sheet title="Add tool" testID="new-panel-sheet">
      <View style={[styles.menu, { borderRadius: theme.radius.lg, borderColor: colors.border, backgroundColor: colors.surface }]}>
        {newPanelOptions(affordances.data?.customCommands ?? []).map(option => {
          const icon = ICONS[option.id] ?? TERMINAL_ICON;
          return (
            <Pressable
              key={option.id}
              testID={`new-panel-${option.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${option.title}, ${option.description}`}
              accessibilityState={{ disabled: create.isPending }}
              disabled={create.isPending}
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
    </Sheet>
  );
}

const styles = StyleSheet.create({
  menu: { overflow: 'hidden', borderWidth: 1 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  icon: { marginTop: 2 },
  body: { flex: 1, minWidth: 0 },
});
