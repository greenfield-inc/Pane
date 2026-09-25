import { Image } from 'expo-image';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConnectForm } from '@/features/pairing/ConnectForm';
import { useTheme } from '@/theme';
import { Text } from '@/ui';

export default function ConnectScreen() {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <Image source={require('../../assets/images/icon.png')} style={styles.logo} accessibilityIgnoresInvertColors />
            <Text variant="largeTitle">Pane</Text>
            <Text variant="callout" tone="muted" style={styles.center}>
              Connect to the Pane running on your computer to watch and steer your agents from here.
            </Text>
          </View>
          <ConnectForm />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 32 },
  hero: { alignItems: 'center', gap: 8 },
  logo: { width: 88, height: 88, borderRadius: 20, marginBottom: 8 },
  center: { textAlign: 'center' },
});
