import { Children, Fragment, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

export interface ListSectionProps {
  title?: string;
  footer?: string;
  children: ReactNode;
}

/** An inset grouped section of ListRows with hairline separators. */
export function ListSection({ title, footer, children }: ListSectionProps) {
  const theme = useTheme();
  const rows = Children.toArray(children);
  return (
    <View style={styles.container}>
      {title ? <Text variant="footnote" tone="muted" style={styles.caption}>{title.toUpperCase()}</Text> : null}
      <View style={[styles.group, { borderRadius: theme.radius.md, backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <View style={[styles.separator, { backgroundColor: theme.colors.border }]} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? <Text variant="footnote" tone="muted" style={styles.caption}>{footer}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  caption: { paddingHorizontal: 16 },
  group: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
});
