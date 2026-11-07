import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useChatTab } from '@/features/chatTab/useChatTab';
import { useTheme, withAlpha } from '@/theme';
import { Button, Icon, Text } from '@/ui';

import { awayLine, awaySummary, parseLogEntries, type SentinelLogEntry } from '@shared/autopilotTranscript';

const KIND: Record<SentinelLogEntry['kind'], { label: string; glyph: { ios: SFSymbol; android: AndroidSymbol } }> = {
  answered: { label: 'Answered', glyph: { ios: 'checkmark.circle', android: 'check_circle' } },
  nudged: { label: 'Nudged', glyph: { ios: 'chevron.right', android: 'chevron_right' } },
  sent: { label: 'Sent to you', glyph: { ios: 'bell', android: 'notifications' } },
};

function EntryIcon({ kind }: { kind: SentinelLogEntry['kind'] }) {
  const { colors } = useTheme();
  const color = kind === 'answered' ? colors.success : kind === 'sent' ? colors.warning : colors.textMuted;
  return <View style={styles.iconBox}><Icon {...KIND[kind].glyph} size={15} color={color} /></View>;
}

/** An `autopilot-log` block: Sentinel's calls as it makes them, one tinted line each (round 7, d1). */
export function SentinelLogRows({ content }: { content: string }) {
  const { colors } = useTheme();
  const entries = parseLogEntries(content);
  if (entries.length === 0) return null;
  return (
    <View testID="autopilot-log" style={styles.log}>
      {entries.map((entry, index) => (
        <View key={`${entry.at}-${index}`} style={[styles.logRow, { backgroundColor: withAlpha(colors.autopilot, 0.1) }]}>
          <EntryIcon kind={entry.kind} />
          <Text variant="subhead" style={styles.shrink}>
            <Text variant="subhead" style={styles.bold}>{KIND[entry.kind].label} </Text>
            <Text variant="subhead" tone="secondary">{[entry.session, entry.what].filter(Boolean).join(' · ')}{entry.why ? ` (${entry.why})` : ''}</Text>
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * An `autopilot-away` block (round 7, d2): what Sentinel did while you were away, a way to tell a
 * Session otherwise (sent to Autopilot, which passes it on as yours), and the full away log.
 */
export function SentinelAwayCard({ content, panelId }: { content: string; panelId: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const [correcting, setCorrecting] = useState(false);
  const summary = awaySummary(content);
  const entries = parseLogEntries(content);
  const sessions = [...new Set(entries.map(entry => entry.session).filter(Boolean))];
  return (
    <View testID="autopilot-away" style={[styles.card, { borderColor: withAlpha(colors.autopilot, 0.45), backgroundColor: colors.surface }]}>
      <View style={[styles.head, { borderBottomColor: colors.border }]}>
        <View style={styles.iconBox}><Icon ios="shield" android="shield" size={16} color={colors.autopilot} /></View>
        <View style={styles.shrink}>
          <Text variant="headline">While you were away</Text>
          <Text testID="autopilot-away-line" variant="footnote" tone="muted">{awayLine(content)}</Text>
        </View>
      </View>
      {entries.length === 0 ? <Text variant="subhead" tone="muted" style={styles.empty}>Nothing needed a call while you were away.</Text> : null}
      {entries.map((entry, index) => (
        <View key={`${entry.at}-${index}`} style={[styles.row, index > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
          <EntryIcon kind={entry.kind} />
          <View style={styles.shrink}>
            <Text variant="subhead">
              <Text variant="subhead" style={styles.bold}>{KIND[entry.kind].label} </Text>
              {entry.session ? `${entry.session}: ` : ''}{entry.what}
            </Text>
            {entry.why ? <Text variant="footnote" tone="muted">{entry.why}</Text> : null}
          </View>
          <Text variant="footnote" tone="muted">{entry.at}</Text>
        </View>
      ))}
      {correcting ? <Correction panelId={panelId} sessions={sessions} onSent={() => setCorrecting(false)} /> : null}
      <View style={[styles.actions, { borderTopColor: colors.border }]}>
        <Button testID="autopilot-away-correct" title="Tell a Session otherwise" variant="secondary" onPress={() => setCorrecting(!correcting)} />
        {summary?.log ? (
          <Button testID="autopilot-away-log" title="Open the away log" variant="secondary"
            onPress={() => router.push({ pathname: '/autopilot/doc', params: { path: summary.log ?? '', label: 'Away log' } })} />
        ) : null}
      </View>
    </View>
  );
}

/** Your correction goes to Autopilot, which relays it to the Session as yours. */
function Correction({ panelId, sessions, onSent }: { panelId: string; sessions: string[]; onSent: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const { chat, connected } = useChatTab(panelId);
  const [session, setSession] = useState(sessions[0] ?? '');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const receipt = await chat.send(panelId, { operationId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, text: `Tell ${session || 'that Session'} otherwise, from me: ${text.trim()}` });
      if (receipt.state === 'failed') setError(receipt.error ?? 'Autopilot did not take it.');
      else { setText(''); onSent(); }
    } catch (sendError) {
      setError(`${sendError instanceof Error ? sendError.message : String(sendError)} It may not have reached Autopilot; check the chat before sending again.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View testID="autopilot-away-correction" style={[styles.correction, { borderTopColor: colors.border }]}>
      {sessions.length > 1 ? (
        <View style={styles.sessions}>
          {sessions.map(name => (
            <Pressable key={name} accessibilityRole="radio" accessibilityState={{ selected: name === session }} onPress={() => setSession(name)}
              style={[styles.sessionChip, { borderColor: name === session ? colors.autopilot : colors.border }]}>
              <Text variant="subhead">{name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <TextInput testID="autopilot-away-text" accessibilityLabel="Your correction" placeholder={`What should ${session || 'it'} do instead?`} placeholderTextColor={colors.textMuted}
        value={text} onChangeText={setText} multiline style={[styles.input, { color: colors.text, borderColor: colors.border, borderRadius: theme.radius.md }]} />
      {error ? <Text variant="footnote" tone="danger">{error}</Text> : null}
      <Button testID="autopilot-away-send" title="Send to Autopilot" loading={busy} disabled={!text.trim() || !connected} onPress={() => void send()} />
    </View>
  );
}

const styles = StyleSheet.create({
  shrink: { flex: 1, minWidth: 0 },
  bold: { fontWeight: '600' },
  iconBox: { width: 18, height: 20, alignItems: 'center', justifyContent: 'center' },
  log: { gap: 6, paddingVertical: 2 },
  logRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, alignSelf: 'flex-start', maxWidth: '100%', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 },
  card: { borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  empty: { paddingHorizontal: 14, paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  correction: { gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  sessions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  sessionChip: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 9, minHeight: 30, justifyContent: 'center' },
  input: { minHeight: 44, maxHeight: 120, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
});
