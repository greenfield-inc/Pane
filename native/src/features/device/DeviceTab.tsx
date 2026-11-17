import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

import type { DeviceInput, DevicePanelState } from '@shared/types/devices';
import type { ToolPanel } from '@shared/types/panels';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

import { invokeChannel, useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

/** Frames over the phone's connection: about twice a second while the tab is shown. */
const FRAME_MS = 500;
const ASPECT = { ios: 402 / 874, android: 412 / 915 } satisfies Record<DevicePanelState['platform'], number>;
const panelStateSchema = boundary.object({
  platform: boundary.enumeration('ios', 'android'),
  name: boundary.string,
  os: boundary.optional(boundary.string),
  machine: boundary.string,
  phase: boundary.string,
});

/**
 * A device tab on the phone: the device's screen as frames from the computer, a tap as a touch,
 * and Home. Live video stays on the desktop.
 */
export function DeviceTab({ panel }: { panel: ToolPanel }) {
  const { colors } = useTheme();
  const { client } = useDaemon();
  const state = decodeOptionalBoundary(panel.state.customState, panelStateSchema);
  const live = state?.phase === 'live';
  const [frame, setFrame] = useState<string>();
  const [size, setSize] = useState<{ width: number; height: number }>();

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await invokeChannel<string>(client, 'devices:frame', [panel.id]).catch(() => undefined);
      if (cancelled) return;
      if (next) setFrame(next);
      timer = setTimeout(() => { void tick(); }, FRAME_MS);
    };
    void invokeChannel(client, 'devices:visible', [panel.id, 'phone', true]).catch(() => undefined);
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      void invokeChannel(client, 'devices:visible', [panel.id, 'phone', false]).catch(() => undefined);
    };
  }, [client, panel.id, live]);

  const send = (input: DeviceInput) => { void invokeChannel(client, 'devices:input', [panel.id, input]).catch(() => undefined); };
  const tap = (event: GestureResponderEvent) => {
    if (!size) return;
    const x = event.nativeEvent.locationX / size.width;
    const y = event.nativeEvent.locationY / size.height;
    send({ kind: 'touch', phase: 'begin', x, y });
    send({ kind: 'touch', phase: 'end', x, y });
  };
  const aspect = ASPECT[state?.platform ?? 'ios'];

  return (
    <View testID="device-tab" style={[styles.fill, { backgroundColor: colors.background }]}>
      <View testID="device-screen" style={[styles.phone, { aspectRatio: aspect, borderColor: colors.deviceBezel, backgroundColor: colors.deviceScreen }]} onLayout={(event: LayoutChangeEvent) => setSize(event.nativeEvent.layout)}>
        {live && frame
          ? <Pressable testID="device-screen-touch" style={StyleSheet.absoluteFill} onPress={tap} accessibilityLabel="Device screen"><Image source={{ uri: frame }} style={StyleSheet.absoluteFill} resizeMode="cover" /></Pressable>
          : <View style={styles.offScreen}><Text variant="subhead" style={[styles.offText, { color: colors.onAccent }]}>{live ? 'Loading the screen…' : 'Not running. Open it from the agent or on the computer.'}</Text></View>}
      </View>
      <View style={styles.footer}>
        <Text variant="footnote" tone="secondary" numberOfLines={1}>{[state?.name ?? panel.title, state?.os, state?.machine].filter(Boolean).join(' · ')}</Text>
        <Pressable testID="device-home" accessibilityRole="button" accessibilityLabel="Home" disabled={!live} onPress={() => send({ kind: 'button', button: 'home' })} style={styles.home}>
          <Icon ios="house" android="home" size={20} color={live ? colors.text : colors.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  phone: { maxHeight: '88%', maxWidth: '100%', height: '88%', borderRadius: 28, borderWidth: 6, overflow: 'hidden' },
  offScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  offText: { textAlign: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  home: { padding: 8 },
});
