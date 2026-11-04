import type { ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, useWindowDimensions, View } from 'react-native';

import { onOffValues, phoneSettingsOrder, type ComposerControls } from '@shared/chatComposerControls';
import type { AgentChatConfigOption } from '@shared/types/agentChat';

import { useTheme } from '@/theme';
import { Icon, ListSection, Text } from '@/ui';

export interface ChatTabSettingsProps {
  arranged: ComposerControls;
  disabled: boolean;
  configure: (id: string, value: string) => void;
}

/** One choice or switch, as an iOS Settings row; screen readers hear it as a radio or a switch with its state. */
function Row({ testID, title, role, checked, disabled, onPress, trailing }: {
  testID: string; title: string; role: 'radio' | 'switch'; checked: boolean; disabled: boolean; onPress: () => void; trailing?: ReactNode;
}) {
  const theme = useTheme();
  return <Pressable testID={testID} accessibilityRole={role} accessibilityLabel={title} accessibilityState={{ checked, disabled }}
    disabled={disabled} onPress={onPress} android_ripple={{ color: theme.colors.surfacePressed }}
    style={({ pressed }) => [styles.row, { backgroundColor: pressed && Platform.OS === 'ios' ? theme.colors.surfacePressed : theme.colors.card, opacity: disabled ? 0.55 : 1 }]}>
    <Text variant="rowTitle" numberOfLines={1} style={styles.title}>{title}</Text>
    {trailing}
  </Pressable>;
}

function SwitchRow({ control, title, disabled, configure }: { control: AgentChatConfigOption; title: string } & Omit<ChatTabSettingsProps, 'arranged'>) {
  const toggle = onOffValues(control);
  if (!toggle) return null;
  const on = control.currentValue === toggle.on;
  // The row is the target; the Switch only draws the state.
  return <Row testID={`chat-config-${control.id}`} title={title} role="switch" checked={on} disabled={disabled}
    onPress={() => configure(control.id, on ? toggle.off : toggle.on)}
    trailing={<View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Switch value={on} disabled={disabled} /></View>} />;
}

function Choices({ control, title, disabled, configure }: { control: AgentChatConfigOption; title: string } & Omit<ChatTabSettingsProps, 'arranged'>) {
  const theme = useTheme();
  return <ListSection title={title}>
    {control.options.map(option => {
      const checked = option.value === control.currentValue;
      return <Row key={option.value} testID={`chat-config-${control.id}-${option.value}`} title={option.name} role="radio" checked={checked} disabled={disabled}
        onPress={() => { if (!checked) configure(control.id, option.value); }}
        trailing={<View style={styles.check}>{checked && <Icon ios="checkmark" android="check" size={17} color={theme.colors.accent} />}</View>} />;
    })}
  </ListSection>;
}

/**
 * The phone's settings sheet (D-118): Model, Effort, the agent's other settings and Permissions,
 * as grouped lists with checkmarks; On/Off settings are switches.
 */
export function ChatTabSettings({ arranged, disabled, configure }: ChatTabSettingsProps) {
  const { height } = useWindowDimensions();
  // Neighbouring On/Off settings share one card, as in iOS Settings.
  const groups: Array<Array<{ control: AgentChatConfigOption; title: string }>> = [];
  for (const entry of phoneSettingsOrder(arranged)) {
    const last = groups.at(-1);
    if (onOffValues(entry.control) && last && onOffValues(last[0].control)) last.push(entry);
    else groups.push([entry]);
  }
  // A short grouped form, as in Settings' screens (Screen scroll), not a data list: Legend List doesn't apply.
  return <ScrollView testID="chat-settings-list" style={{ maxHeight: height * 0.75 }} contentContainerStyle={styles.list}>
    {groups.map(group => onOffValues(group[0].control)
      ? <ListSection key={group[0].control.id}>{group.map(({ control, title }) => <SwitchRow key={control.id} control={control} title={title} disabled={disabled} configure={configure} />)}</ListSection>
      : <Choices key={group[0].control.id} control={group[0].control} title={group[0].title} disabled={disabled} configure={configure} />)}
  </ScrollView>;
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 20 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12 },
  title: { flex: 1, minWidth: 0 },
  check: { width: 20, alignItems: 'center' },
});
