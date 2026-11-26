import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { monoFontFamily, useTheme } from '@/theme';
import { Skeleton, SkeletonSwap, Text } from '@/ui';

import { usePendingPermissions, useProjects, useRespondToPermission } from './hooks';
import { DialogSection, DialogSheet, Notice, SheetButton } from './PaneKit';
import { describePermission } from './permissions';
import { Focusable } from '@/features/controller/Focusable';

/** No PWA equivalent; drawn as a PWA dialog with the same tokens. */
export function PermissionSheet({ paneId, requestId }: { paneId: string; requestId?: string }) {
  const theme = useTheme();
  const pending = usePendingPermissions();
  const projects = useProjects();
  const respond = useRespondToPermission();
  const [showInput, setShowInput] = useState(false);
  const request = (pending.data ?? []).find(candidate =>
    requestId ? candidate.id === requestId : candidate.sessionId === paneId);
  const paneName = (projects.data ?? []).flatMap(project => project.sessions ?? []).find(session => session.id === paneId)?.name;
  const card = { borderRadius: theme.radius.lg, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised };

  if (!request) {
    return (
      <DialogSheet
        testID="permission-sheet"
        title="Permission request"
        onClose={() => router.back()}
        footer={
          <SkeletonSwap loading={pending.isPending} style={styles.footer} skeleton={
            <View style={styles.footer}>
              <Skeleton height={40} radius={theme.radius.md} style={styles.answer} />
              <Skeleton height={40} radius={theme.radius.md} style={styles.answer} />
            </View>}>
            <SheetButton title="Close" onPress={() => router.back()} />
          </SkeletonSwap>}
      >
        <DialogSection divided={false}>
          <SkeletonSwap loading={pending.isPending} skeleton={
            // Who is waiting, then the target's card, then Show full input.
            <View testID="permission-skeleton" accessible accessibilityLabel="Loading permission request" style={styles.bones}>
              <Skeleton width="70%" height={14} style={styles.subheadBone} />
              <Skeleton height={46} radius={theme.radius.lg} />
              <Skeleton width="40%" height={12} style={styles.footnoteBone} />
            </View>}>
            <Text testID="permission-missing" variant="subhead" tone={pending.isError ? 'danger' : 'secondary'}>
              {pending.isError ? pending.error.message : 'This request was already answered.'}
            </Text>
          </SkeletonSwap>
        </DialogSection>
      </DialogSheet>
    );
  }

  const { title, target, detail } = describePermission(request);
  const answer = (behavior: 'allow' | 'deny') => {
    respond.mutate([request.id, behavior === 'allow' ? { behavior } : { behavior, message: 'Denied from Pane on the phone.' }], {
      onSuccess: () => {
        void Haptics.notificationAsync(behavior === 'allow' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
        router.back();
      },
    });
  };
  const answering = (behavior: 'allow' | 'deny') => respond.isPending && respond.variables?.[1].behavior === behavior;

  return (
    <DialogSheet
      testID="permission-sheet"
      title={title}
      onClose={() => router.back()}
      closeDisabled={respond.isPending}
      footer={
        // Side by side so both answers fit at the half-height detent.
        <>
          <SheetButton testID="permission-deny" variant="danger" title="Deny" loading={answering('deny')} disabled={respond.isPending} onPress={() => answer('deny')} style={styles.answer} />
          <SheetButton testID="permission-allow" variant="primary" title="Allow" loading={answering('allow')} disabled={respond.isPending} onPress={() => answer('allow')} style={styles.answer} />
        </>
      }
    >
      <DialogSection divided={false}>
        <Text variant="subhead" tone="secondary">{`${paneName ?? 'A pane'} is waiting for your approval.`}</Text>
        {target ? (
          <View style={[styles.card, card]}>
            <Text testID="permission-target" selectable variant="subhead" style={{ fontFamily: monoFontFamily }}>{target}</Text>
          </View>
        ) : null}
        {/* The target is usually enough; the full input would push the answers off a half-height sheet. */}
        {showInput || !target ? (
          <View style={[styles.card, card]}>
            <Text selectable variant="footnote" tone="secondary" style={{ fontFamily: monoFontFamily }}>{detail}</Text>
          </View>
        ) : (
          <Focusable style={styles.disclosure} onActivate={() => setShowInput(true)}>
            <Pressable testID="permission-show-input" accessibilityRole="button" hitSlop={8} onPress={() => setShowInput(true)}>
              <Text variant="footnote" tone="accent">{`Show full ${request.toolName} input`}</Text>
            </Pressable>
          </Focusable>
        )}
        {respond.isError ? <Notice testID="permission-error" danger message={respond.error.message} /> : null}
      </DialogSection>
    </DialogSheet>
  );
}

const styles = StyleSheet.create({
  // Its own width, so the ring hugs the link instead of the whole row.
  disclosure: { alignSelf: 'flex-start' },
  // rounded-xl border bg-surface-secondary p-3.
  card: { padding: 12, borderWidth: 1 },
  answer: { flex: 1 },
  // The sheet footer's row, so the skeleton's buttons and Close sit where Deny and Allow do.
  footer: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  // Bones centered on their text's line (subhead 20, footnote 16); the card is one subhead line in p-3 with a border.
  bones: { gap: 8 },
  subheadBone: { marginVertical: 3 },
  footnoteBone: { marginVertical: 2 },
});
