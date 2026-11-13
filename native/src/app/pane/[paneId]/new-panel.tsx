import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { chatTabProfileLaunch } from '@shared/chatTabProfileLaunch';

import type { ChatTabCreate } from '@shared/types/chatTab';
import type { ToolPanel } from '@shared/types/panels';

import { useInvokeMutation } from '@/daemon';
import { createPanelRequest, newPanelOptions, type NewPanelOption } from '@/features/terminal/panels';
import { useChatAgents } from '@/features/chatTab/useChatTab';
import { useAffordances } from '@/features/hosts/hostSettings';
import { useTheme } from '@/theme';
import { Button, ErrorState, Icon, Sheet, Text, TextField } from '@/ui';

// Stand-ins for the web app's brand icons, which have no system symbol, by the agents config's `icon` key.
const BRAND_ICONS: Readonly<Record<string, { ios: SFSymbol; android: AndroidSymbol }>> = {
  claude: { ios: 'asterisk', android: 'asterisk' },
  codex: { ios: 'hexagon', android: 'hexagon' },
  cursor: { ios: 'cube', android: 'deployed_code' },
};
// An agent with no brand symbol: a chat or a terminal symbol.
const CHAT_ICON = { ios: 'bubble.left', android: 'chat_bubble' } as const;
const PROFILE_ICON = { ios: 'leaf', android: 'eco' } as const;
const TERMINAL_ICON = { ios: 'apple.terminal', android: 'terminal' } as const;

/** The web app's Add tool menu: opens a new terminal tab in the pane, a shell or an agent. */
export default function NewPanelSheet() {
  // `sessionId` when the pane is a Session's workspace: the new tab opens back in the Session.
  const { paneId, sessionId } = useLocalSearchParams<{ paneId: string; sessionId?: string }>();
  const theme = useTheme();
  const { colors } = theme;
  const affordances = useAffordances();
  const catalog = useChatAgents();
  const create = useInvokeMutation<[ReturnType<typeof createPanelRequest>], ToolPanel>('panels:create', {
    invalidates: ['panels:list'],
  });
  const createChat = useInvokeMutation<[ChatTabCreate], { panelId: string }>('chat-tab:create', { invalidates: ['panels:list'] });
  const setActive = useInvokeMutation<[string, string]>('panels:set-active');
  const pending = create.isPending || createChat.isPending;
  // "Agent Farm profile…" asks for the profile and its arguments in the sheet before the tab opens.
  const [profileForm, setProfileForm] = useState<{ profile: string; args: string; field?: 'profile' | 'args'; error?: string } | null>(null);
  const openProfile = () => {
    if (!profileForm) return;
    const parsed = chatTabProfileLaunch(profileForm.profile, profileForm.args);
    if (!parsed.ok) { setProfileForm({ ...profileForm, field: parsed.field, error: parsed.error }); return; }
    setProfileForm({ ...profileForm, field: undefined, error: undefined });
    createChat.mutate([{ sessionId: paneId, launch: parsed.launch }], { onSuccess: result => opened(result.panelId) });
  };

  const opened = (panelId: string) => {
    setActive.mutate([paneId, panelId]);
    if (sessionId) router.dismissTo({ pathname: '/session/[sessionId]', params: { sessionId, panelId } });
    else router.dismissTo({ pathname: '/pane/[paneId]', params: { paneId, panelId } });
  };
  const open = (option: NewPanelOption) => {
    if (option.chatProfile) {
      createChat.reset();
      setProfileForm(form => form ?? { profile: '', args: '' });
      return;
    }
    if (option.chat) {
      createChat.mutate([{ sessionId: paneId, agent: option.chat }], { onSuccess: result => opened(result.panelId) });
      return;
    }
    create.mutate([createPanelRequest(paneId, option)], { onSuccess: panel => opened(panel.id) });
  };

  return (
    <Sheet title="Add tool" testID="new-panel-sheet">
      <View style={[styles.menu, { borderRadius: theme.radius.lg, borderColor: colors.border, backgroundColor: colors.surface }]}>
        {newPanelOptions(affordances.data?.customCommands ?? [], affordances.data?.chatTabsEnabled === true, catalog).map(option => {
          const brand = option.iconKey && Object.hasOwn(BRAND_ICONS, option.iconKey) ? BRAND_ICONS[option.iconKey] : undefined;
          const icon = brand ?? (option.chat ? CHAT_ICON : option.chatProfile ? PROFILE_ICON : TERMINAL_ICON);
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
      {profileForm ? (
        <View style={styles.form} testID="new-panel-profile-form">
          <TextField testID="new-panel-profile-name" label="Agent Farm profile" placeholder="greenfield/implementer" autoCapitalize="none" autoCorrect={false} autoFocus
            value={profileForm.profile} editable={!pending} error={profileForm.field === 'profile' ? profileForm.error : null}
            hint="A name from agent-farm profiles list on the computer."
            onChangeText={profile => setProfileForm({ ...profileForm, profile })} />
          <TextField testID="new-panel-profile-args" label="Arguments (optional)" placeholder="ticket=PANE-12" autoCapitalize="none" autoCorrect={false} multiline mono
            value={profileForm.args} editable={!pending} error={profileForm.field === 'args' ? profileForm.error : null}
            hint="One key=value per line."
            onChangeText={args => setProfileForm({ ...profileForm, args })} />
          <Button testID="new-panel-profile-open" title="Open chat" onPress={openProfile} loading={createChat.isPending} />
        </View>
      ) : null}
      {create.isError ? <ErrorState title="Couldn’t open the tab" error={create.error} /> : null}
      {createChat.isError ? <ErrorState title="Couldn’t open the chat" error={createChat.error} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12, marginTop: 16 },
  menu: { overflow: 'hidden', borderWidth: 1 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  icon: { marginTop: 2 },
  body: { flex: 1, minWidth: 0 },
});
