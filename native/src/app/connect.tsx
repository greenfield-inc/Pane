import * as Linking from 'expo-linking';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useHostsStore } from '@/auth/hostsStore';
import { PRIVACY_POLICY_URL } from '@/features/app/privacyPolicy';
import { ComputersScreen } from '@/features/computers/ComputersScreen';
import { ConnectForm } from '@/features/pairing/ConnectForm';
import { PairingCamera } from '@/features/pairing/PairingCamera';
import { useTheme } from '@/theme';
import { Button, Icon, Text } from '@/ui';
import type { IconProps } from '@/ui/Icon';

/** Pane on runpane.com, for someone who has the app but no Pane on a computer yet. */
const GET_PANE_URL = 'https://runpane.com';

/**
 * First launch opens on the camera: scan the code in Pane on your computer. Below it: paste a
 * connection code, use Tailscale instead (Your computers), or try the demo.
 */
export default function ConnectScreen() {
  const theme = useTheme();
  const startDemo = useHostsStore(state => state.startDemo);
  const [mode, setMode] = useState<'camera' | 'connect' | 'computers'>('camera');

  if (mode === 'camera') {
    return (
      <PairingCamera
        caption="Scan the code in Pane on your computer"
        actions={(
          <>
            <Button testID="connect-open-form" title="Paste a connection code" variant="secondary" onPress={() => setMode('connect')} />
            <Button testID="connect-computers" title="Use Tailscale instead" variant="secondary" onPress={() => setMode('computers')} />
            <View style={styles.links}>
              <Button testID="connect-try-demo" title="Try a demo" variant="plain" onPress={startDemo} />
              <Button testID="connect-get-pane" title="Get Pane for your computer" variant="plain" onPress={() => void Linking.openURL(GET_PANE_URL)} />
              <Button testID="connect-privacy" title="Privacy policy" variant="plain" onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)} />
            </View>
          </>
        )}
      />
    );
  }

  if (mode === 'computers') {
    return (
      <SafeAreaView style={[styles.fill, { backgroundColor: theme.colors.background }]}>
        <Pressable testID="computers-back" accessibilityRole="button" onPress={() => setMode('camera')} style={[styles.back, styles.backBar]} hitSlop={8}>
          <Icon ios="arrow.left" android="arrow_back" size={16} color={theme.colors.textSecondary} />
          <Text variant="callout" tone="secondary">Back</Text>
        </Pressable>
        <ComputersScreen />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      {/* iOS insets the scroll view for the keyboard itself; Android (edge-to-edge) needs padding. */}
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'android' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.content, styles.contentTop]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
          <View style={styles.header}>
            <IconTile ios="desktopcomputer" android="desktop_windows" />
            <View style={styles.headerText}>
              <Text variant="title">Pane</Text>
              <Text variant="subhead" tone="secondary">Watch and steer your agents from your phone, wherever you are.</Text>
            </View>
          </View>
          <View style={[styles.card, cardStyle(theme)]}>
            <Pressable testID="connect-back" accessibilityRole="button" onPress={() => setMode('camera')} style={styles.back} hitSlop={8}>
              <Icon ios="arrow.left" android="arrow_back" size={16} color={theme.colors.textSecondary} />
              <Text variant="callout" tone="secondary">Back</Text>
            </Pressable>
            <ConnectForm />
          </View>
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
  card: { borderWidth: 1, padding: 16, gap: 8 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
  backBar: { paddingHorizontal: 16, paddingTop: 8 },
  links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
});
