import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

export interface ListSectionProps {
  /** Sentence case, shown as written. */
  title?: string;
  /** Muted text after the title, e.g. the host name in "General  on studio-mac". */
  titleSuffix?: string;
  footer?: string;
  children: ReactNode;
}

/**
 * A grouped card of ListRows, as in iOS Settings. A separator starts at the
 * row's text: 16 in, or 54 below a row with a `leading` icon.
 */
export function ListSection({ title, titleSuffix, footer, children }: ListSectionProps) {
  const theme = useTheme();
  const rows = Children.toArray(children);
  const hasLeading = (row: ReactNode) => isValidElement<{ leading?: ReactNode }>(row) && Boolean(row.props.leading);
  return (
    <View>
      {title ? (
        <View style={styles.label}>
          <Text variant="sectionLabel" tone="muted">{title}</Text>
          {titleSuffix ? <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.suffix}>{titleSuffix}</Text> : null}
        </View>
      ) : null}
      <View style={[styles.card, { borderRadius: theme.radius.card, backgroundColor: theme.colors.card, borderColor: theme.colors.cardBorder }]}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <View style={[styles.separator, { marginLeft: hasLeading(rows[index - 1]) ? 54 : 16, backgroundColor: theme.colors.border }]} />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? <Text variant="rowDetail" tone="muted" style={styles.footer}>{footer}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, paddingTop: 16, paddingHorizontal: 4, paddingBottom: 6 },
  suffix: { flexShrink: 1 },
  card: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  separator: { height: StyleSheet.hairlineWidth },
  footer: { paddingHorizontal: 4, paddingTop: 6 },
});
