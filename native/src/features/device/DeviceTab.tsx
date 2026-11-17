import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

import { agentTabOf } from '@shared/deviceAgentTab';
import type { DeviceCapture, DeviceControls, DeviceInput, DeviceOrientation, DevicePanelState, DevicePosture } from '@shared/types/devices';
import type { ToolPanel } from '@shared/types/panels';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

import { invokeChannel, useDaemon } from '@/daemon';
import { addChatImage } from '@/features/chatTab/chatAddedImages';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';
import type { IconProps } from '@/ui/Icon';

/** Frames over the phone's connection: about twice a second while the tab is shown. */
const FRAME_MS = 500;
/** How often the bar rereads the device's turn and fold, so a change an agent makes shows. */
const CONTROLS_MS = 2_000;
const ASPECT = { ios: 402 / 874, android: 412 / 915 } satisfies Record<DevicePanelState['platform'], number>;
const ORIENTATIONS: DeviceOrientation[] = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'];
const FOLDS: { posture: DevicePosture; label: string; ios: IconProps['ios']; android: IconProps['android'] }[] = [
  { posture: 'closed', label: 'Closed', ios: 'iphone', android: 'smartphone' },
  { posture: 'half', label: 'Half open', ios: 'book', android: 'menu_book' },
  { posture: 'open', label: 'Open', ios: 'rectangle.split.2x1', android: 'splitscreen' },
];
const panelStateSchema = boundary.object({
  platform: boundary.enumeration('ios', 'android'),
  name: boundary.string,
  os: boundary.optional(boundary.string),
  machine: boundary.string,
  phase: boundary.string,
  openedBy: boundary.optional(boundary.string),
  driver: boundary.optional(boundary.union(
    boundary.object({ by: boundary.literal('agent'), agent: boundary.string }),
    boundary.object({ by: boundary.literal('person'), agentWaiting: boundary.optional(boundary.string) }),
  )),
});

/**
 * A device tab on the phone: the device's screen as frames from the computer at the screen's own
 * shape, a tap as a touch, and a bar with Home, Rotate, the fold postures on a foldable and
 * Screenshot to chat, with who is driving above it. A host without the bar's channels (an older
 * desktop) gets Home alone. Live video stays on the desktop.
 */
export function DeviceTab({ panel, panels }: { panel: ToolPanel; panels: readonly ToolPanel[] }) {
  const { colors } = useTheme();
  const { client } = useDaemon();
  const state = decodeOptionalBoundary(panel.state.customState, panelStateSchema);
  const live = state?.phase === 'live';
  const [frame, setFrame] = useState<string>();
  // The screen inside the bezel, for mapping taps; and the room the phone may fill.
  const [box, setBox] = useState<{ width: number; height: number }>();
  const [stage, setStage] = useState<{ width: number; height: number }>();
  const [aspect, setAspect] = useState(ASPECT[state?.platform ?? 'ios']);
  const [controls, setControls] = useState<DeviceControls>();
  const [notice, setNotice] = useState<string>();
  const agentTab = agentTabOf(panels, state?.openedBy);

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

  // Bumped after a turn or fold, so the bar rereads at once.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // An older host has no devices:controls; its tab keeps Home alone.
      const next = await invokeChannel<DeviceControls>(client, 'devices:controls', [panel.id]).catch(() => undefined);
      if (cancelled) return;
      setControls(next);
      timer = setTimeout(() => { void tick(); }, CONTROLS_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, panel.id, live, generation]);

  const send = (input: DeviceInput) => { void invokeChannel(client, 'devices:input', [panel.id, input]).catch(() => undefined); };
  const act = (input: DeviceInput) => { void invokeChannel(client, 'devices:input', [panel.id, input]).then(() => setGeneration(value => value + 1), () => undefined); };
  const tap = (event: GestureResponderEvent) => {
    if (!box) return;
    // The frame is letterboxed in its box: map the tap to the drawn picture.
    const width = Math.min(box.width, box.height * aspect);
    const height = width / aspect;
    const x = (event.nativeEvent.locationX - (box.width - width) / 2) / width;
    const y = (event.nativeEvent.locationY - (box.height - height) / 2) / height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    send({ kind: 'touch', phase: 'begin', x, y });
    send({ kind: 'touch', phase: 'end', x, y });
  };
  const screenshotToChat = async () => {
    // A full-resolution capture takes a few seconds on the computer; say so at once.
    setNotice('Taking a screenshot…');
    try {
      const capture = await invokeChannel<DeviceCapture>(client, 'devices:capture', [panel.id]);
      if (agentTab?.kind === 'chat') {
        const data = capture.dataUrl.slice(capture.dataUrl.indexOf(',') + 1);
        addChatImage(agentTab.id, { key: `device-${Date.now()}`, uri: capture.dataUrl, mimeType: 'image/png', data });
        setNotice('Added to chat');
      } else if (agentTab) {
        await invokeChannel(client, 'devices:stage', [panel.id, agentTab.id, `${capture.path} `]);
        setNotice(`Typed at ${agentTab.agent}'s prompt`);
      } else {
        setNotice('Screenshot saved on the computer');
      }
    } catch {
      setNotice('The screenshot did not work. Try again.');
    }
  };
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const driver = state?.driver;
  const tint = (on: boolean) => (on ? colors.text : colors.textSecondary);
  const button = (label: string, ios: IconProps['ios'], android: IconProps['android'], onPress: () => void, options: { selected?: boolean; accent?: boolean } = {}) => (
    <Pressable
      key={label}
      testID={`device-${label.toLowerCase().replaceAll(' ', '-')}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !live, selected: options.selected }}
      disabled={!live}
      onPress={onPress}
      style={[styles.barButton, options.selected && { backgroundColor: colors.surfacePressed }]}
    >
      <Icon ios={ios} android={android} size={20} color={options.accent && live ? colors.accent : tint(live)} />
    </Pressable>
  );

  return (
    <View testID="device-tab" style={[styles.fill, { backgroundColor: colors.background }]}>
      <View style={styles.stage} onLayout={(event: LayoutChangeEvent) => setStage(event.nativeEvent.layout)}>
      <View
        testID="device-screen"
        style={[styles.phone, fitted(stage, aspect), { borderColor: driver?.by === 'agent' ? colors.accent : colors.deviceBezel, backgroundColor: colors.deviceScreen }]}
      >
        {live && frame
          ? (
            <Pressable testID="device-screen-touch" style={StyleSheet.absoluteFill} onPress={tap} onLayout={(event: LayoutChangeEvent) => setBox(event.nativeEvent.layout)} accessibilityLabel="Device screen">
              <Image
                source={{ uri: frame }}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
                onLoad={(event) => { const { width, height } = event.nativeEvent.source; if (width > 0 && height > 0) setAspect(width / height); }}
              />
            </Pressable>
          )
          : <View style={styles.offScreen}><Text variant="subhead" style={[styles.offText, { color: colors.onAccent }]}>{live ? 'Loading the screen…' : 'Not running. Open it from the agent or on the computer.'}</Text></View>}
      </View>
      </View>
      <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.caption}>{notice ?? [state?.name ?? panel.title, state?.os, state?.machine].filter(Boolean).join(' · ')}</Text>
      {controls && driver && (
        <View testID="device-driver" style={[styles.chip, { borderColor: driver.by === 'agent' ? colors.accent : colors.border }]}>
          <Text variant="footnote" numberOfLines={1}>{driver.by === 'person' ? (driver.agentWaiting ? `You're driving · ${driver.agentWaiting} is waiting` : "You're driving") : `${driver.agent} is driving`}</Text>
          <Pressable testID="device-driver-action" accessibilityRole="button" onPress={() => { void invokeChannel(client, 'devices:driver', [panel.id, driver.by === 'person' ? 'agent' : 'person']).catch(() => undefined); }}>
            <Text variant="footnote" style={{ color: colors.accentText }}>{driver.by === 'person' ? `Hand to ${driver.agentWaiting ?? agentTab?.agent ?? 'agent'}` : 'Take over'}</Text>
          </Pressable>
        </View>
      )}
      <View testID="device-bar" style={[styles.bar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {button('Home', 'house', 'home', () => send({ kind: 'button', button: 'home' }))}
        {controls && (
          <>
            {controls.orientation && button('Rotate', 'rotate.right', 'screen_rotation', () => act({ kind: 'rotate', orientation: ORIENTATIONS[(ORIENTATIONS.indexOf(controls.orientation ?? 'portrait') + 1) % ORIENTATIONS.length] }))}
            {controls.fold && FOLDS.map(fold => button(fold.label, fold.ios, fold.android, () => act({ kind: 'fold', posture: fold.posture }), { selected: controls.fold?.posture === fold.posture }))}
            {button(agentTab ? 'Screenshot to chat' : 'Screenshot', 'camera', 'photo_camera', () => { void screenshotToChat(); }, { accent: true })}
          </>
        )}
      </View>
    </View>
  );
}

/** The largest phone of `aspect` (width over height) that fits `stage`; nothing until the stage is measured. */
function fitted(stage: { width: number; height: number } | undefined, aspect: number) {
  if (!stage || stage.width <= 0 || stage.height <= 0) return { width: 0, height: 0 };
  return stage.width / stage.height > aspect ? { width: stage.height * aspect, height: stage.height } : { width: stage.width, height: stage.width / aspect };
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  stage: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  phone: { borderRadius: 28, borderWidth: 6, overflow: 'hidden' },
  offScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  offText: { textAlign: 'center' },
  caption: { marginTop: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, padding: 4, borderRadius: 999, borderWidth: 1 },
  barButton: { padding: 8, borderRadius: 999 },
});
