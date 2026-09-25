import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from './Text';

export interface EmptyStateProps {
  title: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
  testID?: string;
}

export function EmptyState({ title, message, icon, action, testID }: EmptyStateProps) {
  return (
    <View testID={testID} style={styles.container}>
      {icon}
      <Text variant="title" style={styles.center}>{title}</Text>
      {message ? <Text variant="callout" tone="muted" style={styles.center}>{message}</Text> : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  center: { textAlign: 'center' },
  action: { marginTop: 12, alignSelf: 'stretch' },
});
