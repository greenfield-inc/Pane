import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AGENT_LAUNCH_PRESETS, type AgentLaunchPresetId } from '@shared/constants/agentLaunchPresets';
import { RemoteUnconfirmedResultError } from '@shared/remoteClient';

import { useTheme } from '@/theme';
import { Button, Icon, ListRow, ListSection, Sheet, Text, TextField } from '@/ui';

import { buildCreatePaneRequest, defaultBaseBranch, filterBranches, paneFromCreateResult, suggestPaneName } from './createPane';
import { useBranches, useCreatePane, useProjects } from './hooks';

const VISIBLE_BRANCHES = 8;

export function CreatePaneSheet() {
  const projects = useProjects();
  const createPane = useCreatePane();
  const [chosenProjectId, setChosenProjectId] = useState<number>();
  const [choosingProject, setChoosingProject] = useState(false);
  const [agent, setAgent] = useState<AgentLaunchPresetId>('claude');
  const [chosenBranch, setChosenBranch] = useState<string>();
  const [choosingBranch, setChoosingBranch] = useState(false);
  const [branchQuery, setBranchQuery] = useState('');
  const [editedName, setEditedName] = useState<string>();
  const [error, setError] = useState<string>();

  const projectList = projects.data ?? [];
  const project = projectList.find(candidate => candidate.id === chosenProjectId) ?? projectList[0];
  const branches = useBranches(project?.id);
  const branchList = branches.data ?? [];
  const baseBranch = chosenBranch ?? defaultBaseBranch(branchList);
  const existingNames = (project?.sessions ?? []).map(session => session.name);
  const name = editedName ?? (baseBranch ? suggestPaneName(baseBranch, existingNames, branchList) : '');
  const matchingBranches = filterBranches(branchList, branchQuery);

  const chooseProject = (projectId: number) => {
    setChosenProjectId(projectId);
    setChoosingProject(false);
    setChosenBranch(undefined);
    setEditedName(undefined);
  };

  const submit = () => {
    if (createPane.isPending) return;
    const draft = buildCreatePaneRequest({ projectId: project?.id, name, baseBranch, agent });
    if ('error' in draft) {
      setError(draft.error);
      return;
    }
    setError(undefined);
    createPane.mutate([draft.request], {
      onSuccess: result => {
        try {
          const { paneId } = paneFromCreateResult(result);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.back();
          router.push({ pathname: '/pane/[paneId]', params: { paneId } });
        } catch (createError) {
          setError((createError as Error).message);
        }
      },
      onError: createError => setError(createError instanceof RemoteUnconfirmedResultError
        ? 'The connection dropped before the host answered. Check the pane list before trying again: the pane may already exist.'
        : createError.message),
    });
  };

  return (
    <Sheet
      testID="new-pane-sheet"
      title="New pane"
      footer={
        <>
          {error ? <Text testID="new-pane-error" variant="footnote" tone="danger" accessibilityLiveRegion="polite">{error}</Text> : null}
          <Button testID="new-pane-create" title="Create pane" loading={createPane.isPending} disabled={!project} onPress={submit} />
        </>
      }
    >
      <ListSection title="Repository">
        {choosingProject || !project
          ? projectList.map(candidate => (
            <ListRow
              key={candidate.id}
              testID={`new-pane-repo-${candidate.id}`}
              title={candidate.name}
              trailing={candidate.id === project?.id ? <Check /> : undefined}
              onPress={() => chooseProject(candidate.id)}
            />
          ))
          : (
            <ListRow
              testID="new-pane-repo"
              title={project.name}
              trailing={projectList.length > 1 ? <Text tone="accent">Change</Text> : undefined}
              onPress={projectList.length > 1 ? () => setChoosingProject(true) : undefined}
            />
          )}
      </ListSection>

      <ListSection title="Agent">
        {AGENT_LAUNCH_PRESETS.map(preset => (
          <ListRow
            key={preset.id}
            testID={`new-pane-agent-${preset.id}`}
            title={preset.title}
            subtitle={preset.command}
            trailing={preset.id === agent ? <Check /> : undefined}
            onPress={() => setAgent(preset.id)}
          />
        ))}
      </ListSection>

      <View style={styles.group}>
        <ListSection title="Base branch">
          <ListRow
            testID="new-pane-branch"
            title={baseBranch ?? (branches.isPending ? 'Loading branches…' : 'No branches')}
            leading={<Icon ios="arrow.triangle.branch" android="call_split" size={18} />}
            trailing={branches.isPending ? <ActivityIndicator /> : <Text tone="accent">{choosingBranch ? 'Done' : 'Change'}</Text>}
            onPress={branchList.length > 0 ? () => setChoosingBranch(!choosingBranch) : undefined}
          />
        </ListSection>
        {branches.isError ? <Text testID="new-pane-branch-error" variant="footnote" tone="danger">{branches.error.message}</Text> : null}
        {choosingBranch ? (
          <>
            <TextField
              testID="new-pane-branch-search"
              placeholder="Search branches"
              autoCapitalize="none"
              autoCorrect={false}
              value={branchQuery}
              onChangeText={setBranchQuery}
            />
            <ListSection footer={matchingBranches.length > VISIBLE_BRANCHES ? `${matchingBranches.length - VISIBLE_BRANCHES} more. Search to narrow them down.` : undefined}>
              {matchingBranches.slice(0, VISIBLE_BRANCHES).map(branch => (
                <ListRow
                  key={branch.name}
                  testID={`new-pane-branch-${branch.name}`}
                  title={branch.name}
                  subtitle={branch.isRemote ? 'Remote' : branch.isCurrent ? 'Checked out' : undefined}
                  trailing={branch.name === baseBranch ? <Check /> : undefined}
                  onPress={() => {
                    setChosenBranch(branch.name);
                    setChoosingBranch(false);
                    setBranchQuery('');
                  }}
                />
              ))}
            </ListSection>
          </>
        ) : null}
      </View>

      <TextField
        testID="new-pane-name"
        label="Pane name"
        hint="Also names the worktree and its branch."
        autoCapitalize="none"
        autoCorrect={false}
        value={name}
        onChangeText={setEditedName}
        returnKeyType="done"
        onSubmitEditing={submit}
      />
    </Sheet>
  );
}

function Check() {
  const theme = useTheme();
  return <Icon ios="checkmark" android="check" size={16} color={theme.colors.accentText} />;
}

const styles = StyleSheet.create({
  group: { gap: 10 },
});
