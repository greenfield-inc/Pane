import { StyleSheet, TextInput, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon } from '@/ui';

import { IconButton } from './PaneKit';

/** Home's borderless search field, with a clear button while it holds text. */
export function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.toolbar}>
      <View style={[styles.search, { borderRadius: theme.radius.lg, backgroundColor: theme.colors.surfaceRaised }]}>
        <Icon ios="magnifyingglass" android="search" size={16} />
        <TextInput
          testID="panes-search"
          accessibilityLabel="Search panes"
          placeholder="Search panes"
          placeholderTextColor={theme.colors.textMuted}
          selectionColor={theme.colors.accent}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          value={value}
          onChangeText={onChange}
          style={[theme.typography.body, styles.input, { color: theme.colors.text }]}
        />
        {value ? (
          <IconButton label="Clear search" testID="panes-search-clear" size={28} onPress={() => onChange('')}>
            <Icon ios="xmark.circle.fill" android="cancel" size={16} />
          </IconButton>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { paddingHorizontal: 16, paddingBottom: 4 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingLeft: 12, paddingRight: 6 },
  input: { flex: 1, paddingVertical: 8 },
});
