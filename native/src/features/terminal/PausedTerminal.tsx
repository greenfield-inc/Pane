import { useRef } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { TerminalPausedMark } from '@shared/types/panels';
import type { RunpanePanelScreenResult } from '@shared/types/runpaneOrchestration';

import { useInvokeQuery } from '@/daemon';
import { useTheme, monoFontFamily } from '@/theme';
import { Icon, SkeletonSwap, Text } from '@/ui';

import { pausedLabel } from '../panes/paused';
import { PausedBadge } from '../panes/StatusBadge';
import { TerminalSkeleton } from './TerminalSkeletons';

/** Lines of the saved screen to show; the desktop's banner sits over one screenful. */
const SCREEN_LINES = 300;
const DIMMED_OPACITY = 0.55;

/**
 * A paused terminal tab: the "Paused … · last screen" bar with Resume (when the phone may), over the tab's saved last
 * screen, dimmed. It starts nothing on the host; only Resume does.
 */
export function PausedTerminal({ panelId, mark, resuming, onResume }: {
  panelId: string;
  mark: TerminalPausedMark;
  resuming: boolean;
  onResume?: () => void;
}) {
  const theme = useTheme();
  const scroll = useRef<ScrollView>(null);
  const screen = useInvokeQuery<RunpanePanelScreenResult>('runpane:panels:screen', [{ panelId, limit: SCREEN_LINES }]);

  return (
    <View testID="paused-terminal" style={[styles.fill, { backgroundColor: theme.terminal.background }]}>
      <View
        testID="paused-bar"
        style={[styles.bar, { backgroundColor: theme.colors.surfaceRaised, borderBottomColor: theme.colors.border }]}
      >
        <PausedBadge />
        <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.label} accessibilityRole="header">
          <Text variant="footnote" style={styles.bold}>{pausedLabel(mark, Date.now())}</Text>
          <Text variant="footnote" tone="muted">{' · last screen'}</Text>
        </Text>
        {onResume ? <Pressable
          testID="paused-resume"
          accessibilityRole="button"
          accessibilityLabel="Resume"
          accessibilityState={{ busy: resuming, disabled: resuming }}
          disabled={resuming}
          hitSlop={6}
          onPress={onResume}
          style={({ pressed }) => [styles.resume, { borderRadius: theme.radius.md, backgroundColor: theme.colors.accent, opacity: pressed || resuming ? 0.75 : 1 }]}
        >
          {/* One fixed box for the play icon and the spinner, so the button keeps its size. */}
          <View style={styles.resumeIcon}>
            {resuming
              ? <ActivityIndicator size="small" color={theme.colors.onAccent} />
              : <Icon ios="play.fill" android="play_arrow" size={11} color={theme.colors.onAccent} />}
          </View>
          <Text variant="caption" tone="onAccent">Resume</Text>
        </Pressable> : null}
      </View>
      <SkeletonSwap
        loading={screen.isPending}
        skeleton={<TerminalSkeleton testID="paused-skeleton" label="Loading the last screen" style={styles.dimmed} />}
        style={styles.fill}
      >
        <ScrollView
          ref={scroll}
          testID="paused-screen"
          style={[styles.fill, styles.dimmed]}
          contentContainerStyle={styles.screen}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        >
          <Text
            selectable
            style={[styles.text, { color: theme.terminal.foreground, fontFamily: monoFontFamily }]}
          >
            {screen.data?.text || (screen.isError ? 'The last screen could not be read.' : 'No saved screen.')}
          </Text>
        </ScrollView>
      </SkeletonSwap>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  dimmed: { opacity: DIMMED_OPACITY },
  // The desktop banner: h-34 px-3.5, a pause glyph, the label, Resume on the right.
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingLeft: 14, paddingRight: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  label: { flex: 1 },
  bold: { fontWeight: '600' },
  resume: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, paddingHorizontal: 10 },
  resumeIcon: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  // The live terminal's 8 pt inset.
  screen: { paddingHorizontal: 8, paddingVertical: 8 },
  text: { fontSize: 12, lineHeight: 16 },
});
