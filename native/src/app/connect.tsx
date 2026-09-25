import * as Linking from 'expo-linking';
import { useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConnectForm } from '@/features/pairing/ConnectForm';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';
import type { IconProps } from '@/ui/Icon';

const SETUP_GUIDE_URL = 'https://runpane.com/docs/remote-daemon';

/** First launch, as in the PWA: pick "Connect with a code" or the setup guide, then the form. */
export default function ConnectScreen() {
  const theme = useTheme();
  const [mode, setMode] = useState<'menu' | 'connect'>('menu');

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      {/* iOS insets the scroll view for the keyboard itself; Android (edge-to-edge) needs padding. */}
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'android' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.content, mode === 'connect' && styles.contentTop]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
          <View style={styles.header}>
            <IconTile ios="desktopcomputer" android="desktop_windows" />
            <View style={styles.headerText}>
              <Text variant="title">Remote Pane</Text>
              <Text variant="subhead" tone="secondary">Connect to a Pane host from desktop or mobile.</Text>
            </View>
          </View>

          {mode === 'menu' ? (
            <View style={styles.cards}>
              <MenuCard
                testID="connect-open-form"
                icon={<IconTile ios="doc.on.clipboard" android="content_paste" />}
                title="Connect with a code"
                description="Paste a pane-remote:// code from an existing remote host."
                action="Open connection form"
                onPress={() => setMode('connect')}
              />
              <MenuCard
                testID="connect-setup-guide"
                icon={<IconTile ios="book" android="menu_book" />}
                title="Set up a remote host"
                description="Run Pane on a VM, WSL box, server, or desktop and create a connection code."
                action="Open setup guide"
                onPress={() => void Linking.openURL(SETUP_GUIDE_URL)}
              />
            </View>
          ) : (
            <View style={[styles.card, cardStyle(theme)]}>
              <Pressable testID="connect-back" accessibilityRole="button" onPress={() => setMode('menu')} style={styles.back} hitSlop={8}>
                <Icon ios="arrow.left" android="arrow_back" size={16} color={theme.colors.textSecondary} />
                <Text variant="callout" tone="secondary">Back</Text>
              </Pressable>
              <ConnectForm />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function IconTile({ ios, android }: Pick<IconProps, 'ios' | 'android'>) {
  const theme = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radius.md }]}>
      <Icon ios={ios} android={android} size={20} color={theme.colors.accent} />
    </View>
  );
}

function MenuCard({ icon, title, description, action, onPress, testID }: {
  icon: ReactNode; title: string; description: string; action: string; onPress: () => void; testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, cardStyle(theme), pressed && { backgroundColor: theme.colors.surfacePressed }]}
    >
      {icon}
      <Text variant="headline" style={styles.cardTitle}>{title}</Text>
      <Text variant="subhead" tone="secondary">{description}</Text>
      <View style={styles.action}>
        <Text variant="callout" tone="accent" style={styles.actionText}>{action}</Text>
        <Icon ios="arrow.right" android="arrow_forward" size={14} color={theme.colors.accentText} />
      </View>
    </Pressable>
  );
}

// rounded-lg border bg-surface-primary shadow-lg
function cardStyle(theme: ReturnType<typeof useTheme>) {
  return {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    shadowColor: '#000',
    shadowOpacity: theme.scheme === 'light' ? 0.08 : 0,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // px-4 py-6, centered like the PWA's min-h-dvh flex column
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 24 },
  // Keep Connect above the keyboard while typing a code.
  contentTop: { justifyContent: 'flex-start' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 24 },
  headerText: { flex: 1 },
  tile: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  cards: { gap: 12 },
  card: { borderWidth: 1, padding: 16, gap: 8 },
  cardTitle: { marginTop: 4 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  actionText: { fontWeight: '600' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
});
