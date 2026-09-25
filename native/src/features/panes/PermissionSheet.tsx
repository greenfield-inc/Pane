import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { monoFontFamily, useTheme } from '@/theme';
import { Button, Sheet, Text } from '@/ui';

import { usePendingPermissions, useProjects, useRespondToPermission } from './hooks';
import { describePermission } from './permissions';

export function PermissionSheet({ paneId, requestId }: { paneId: string; requestId?: string }) {
  const theme = useTheme();
  const pending = usePendingPermissions();
  const projects = useProjects();
  const respond = useRespondToPermission();
  const request = (pending.data ?? []).find(candidate =>
    requestId ? candidate.id === requestId : candidate.sessionId === paneId);
  const paneName = (projects.data ?? []).flatMap(project => project.sessions ?? []).find(session => session.id === paneId)?.name;

  if (!request) {
    return (
      <Sheet testID="permission-sheet" title="Permission request" footer={<Button title="Close" variant="secondary" onPress={() => router.back()} />}>
        <Text testID="permission-missing" tone={pending.isError ? 'danger' : 'muted'}>
          {pending.isPending ? 'Loading…' : pending.isError ? pending.error.message : 'This request was already answered.'}
        </Text>
      </Sheet>
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

  return (
    <Sheet
      testID="permission-sheet"
      title={title}
      footer={
        <>
          {respond.isError ? <Text testID="permission-error" variant="footnote" tone="danger">{respond.error.message}</Text> : null}
          <Button testID="permission-allow" title="Allow" loading={respond.isPending && respond.variables?.[1].behavior === 'allow'} disabled={respond.isPending} onPress={() => answer('allow')} />
          <Button testID="permission-deny" title="Deny" variant="destructive" loading={respond.isPending && respond.variables?.[1].behavior === 'deny'} disabled={respond.isPending} onPress={() => answer('deny')} />
        </>
      }
    >
      <Text tone="secondary">{`${paneName ?? 'A pane'} is waiting for your approval.`}</Text>
      {target ? (
        <View style={[styles.block, { backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radius.md, borderColor: theme.colors.border }]}>
          <Text testID="permission-target" selectable style={{ fontFamily: monoFontFamily, fontSize: 14 }}>{target}</Text>
        </View>
      ) : null}
      <Text variant="footnote" tone="muted">{`${request.toolName} input`}</Text>
      <View style={[styles.block, { backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radius.md, borderColor: theme.colors.border }]}>
        <Text selectable variant="footnote" tone="secondary" style={{ fontFamily: monoFontFamily }}>{detail}</Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  block: { padding: 12, borderWidth: StyleSheet.hairlineWidth },
});
