import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { router, type Href } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { useProjects } from '@/features/panes/hooks';
import { useSessions } from '@/features/sessions/hooks';
import { useTheme } from '@/theme';
import { Icon, Sheet, Text } from '@/ui';

/** Home's + button: a Session or a Pane, as desktop's New offers. Each opens its own create sheet. */
export default function NewSheet() {
  const sessions = useSessions();
  const projects = useProjects();
  return (
    <Sheet title="New" testID="new-sheet">
      <View style={styles.options}>
        {sessions.unavailable ? null : (
          <NewOption
            testID="sessions-new"
            title="New Session"
            description="Talk to an agent that runs your Panes for you"
            ios="bubble.left"
            android="chat_bubble"
            href="/session/new"
            primary
          />
        )}
        <NewOption
          testID="panes-new"
          title="New Pane"
          description="One agent on its own branch in a repository"
          ios="plus"
          android="add"
          href="/pane/new"
          disabled={(projects.data ?? []).length === 0}
        />
      </View>
    </Sheet>
  );
}

function NewOption({ testID, title, description, ios, android, href, primary = false, disabled = false }: {
  testID: string;
  title: string;
  description: string;
  ios: SFSymbol;
  android: AndroidSymbol;
  href: Href;
  primary?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const tint = primary ? colors.onAccent : colors.text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${description}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => router.replace(href)}
      style={({ pressed }) => [styles.option, {
        borderRadius: theme.radius.lg,
        backgroundColor: primary ? colors.accent : colors.surfaceRaised,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      }]}
    >
      <Icon ios={ios} android={android} size={18} color={tint} />
      <View style={styles.body}>
        <Text variant="callout" style={[styles.title, { color: tint }]}>{title}</Text>
        <Text variant="footnote" numberOfLines={1} style={{ color: primary ? colors.onAccent : colors.textMuted }}>{description}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  options: { gap: 10 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 16, paddingVertical: 10 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontWeight: '600' },
});
