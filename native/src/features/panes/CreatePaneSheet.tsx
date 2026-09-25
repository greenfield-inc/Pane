import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';

import { AGENT_LAUNCH_PRESETS, type AgentLaunchPresetId } from '@shared/constants/agentLaunchPresets';
import { RemoteUnconfirmedResultError } from '@shared/remoteClient';

import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { buildCreatePaneRequest, defaultBaseBranch, filterBranches, paneFromCreateResult, suggestPaneName } from './createPane';
import { useBranches, useCreatePane, useProjects } from './hooks';
import { DialogSection, DialogSheet, Notice, SheetButton } from './PaneKit';

const VISIBLE_BRANCHES = 8;

/** The PWA's "New Pane in <project>" dialog, plus the agent to start. */
export function CreatePaneSheet() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ projectId?: string }>();
  const projects = useProjects();
  const createPane = useCreatePane();
  const branchInput = useRef<TextInput>(null);
  const [chosenProjectId, setChosenProjectId] = useState(params.projectId ? Number(params.projectId) : undefined);
  const [choosingProject, setChoosingProject] = useState(false);
  const [agent, setAgent] = useState<AgentLaunchPresetId>('claude');
  const [chosenBranch, setChosenBranch] = useState<string>();
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState('');
  const [editedName, setEditedName] = useState<string>();
  const [startPinned, setStartPinned] = useState(false);
  const [error, setError] = useState<string>();

  const projectList = projects.data ?? [];
  const project = projectList.find(candidate => candidate.id === chosenProjectId) ?? projectList[0];
  const branches = useBranches(project?.id);
  const branchList = branches.data ?? [];
  const baseBranch = chosenBranch ?? defaultBaseBranch(branchList);
  const existingNames = (project?.sessions ?? []).map(session => session.name);
  // Auto-filled from the branch until the name is edited, as in the PWA.
  const name = editedName ?? (baseBranch ? suggestPaneName(baseBranch, existingNames, branchList) : '');
  const matchingBranches = filterBranches(branchList, branchQuery);
  const field = { borderRadius: theme.radius.md, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised };

  const chooseProject = (projectId: number) => {
    setChosenProjectId(projectId);
    setChoosingProject(false);
    setChosenBranch(undefined);
    setEditedName(undefined);
  };

  const closeBranches = () => {
    setBranchOpen(false);
    setBranchQuery('');
  };

  const submit = () => {
    if (createPane.isPending) return;
    const draft = buildCreatePaneRequest({ projectId: project?.id, name, baseBranch, agent, pinned: startPinned });
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
    <DialogSheet
      testID="new-pane-sheet"
      title={project ? `New Pane in ${project.name}` : 'New Pane'}
      onClose={() => router.back()}
      closeDisabled={createPane.isPending}
      footer={
        <>
          <SheetButton testID="new-pane-cancel" title="Cancel" disabled={createPane.isPending} onPress={() => router.back()} />
          <SheetButton
            testID="new-pane-create"
            variant="primary"
            title={createPane.isPending ? 'Creating...' : 'Create'}
            disabled={createPane.isPending || branches.isPending || !baseBranch}
            onPress={submit}
            style={styles.create}
          />
        </>
      }
    >
      {/* Opened from the header "+" rather than a repository's own. */}
      {!params.projectId && projectList.length > 1 ? (
        <DialogSection>
          <Label ios="folder" android="folder">Repository</Label>
          <Pressable
            testID="new-pane-repo"
            accessibilityRole="button"
            accessibilityLabel={`Repository, ${project?.name ?? ''}`}
            onPress={() => setChoosingProject(!choosingProject)}
            style={[styles.field, field]}
          >
            <Text variant="subhead" numberOfLines={1} style={styles.fill}>{project?.name}</Text>
            <Icon ios={choosingProject ? 'chevron.up' : 'chevron.down'} android={choosingProject ? 'expand_less' : 'expand_more'} size={16} />
          </Pressable>
          {choosingProject ? (
            <Options>
              {projectList.map(candidate => (
                <Option key={candidate.id} testID={`new-pane-repo-${candidate.id}`} title={candidate.name} selected={candidate.id === project?.id} onPress={() => chooseProject(candidate.id)} />
              ))}
            </Options>
          ) : null}
        </DialogSection>
      ) : null}

      <DialogSection>
        <Label ios="arrow.triangle.branch" android="call_split">Base Branch</Label>
        <View style={[styles.field, field, branchOpen && { borderColor: theme.colors.accent }]}>
          <Icon ios="magnifyingglass" android="search" size={16} />
          <TextInput
            ref={branchInput}
            testID="new-pane-branch"
            accessibilityLabel="Base Branch"
            editable={!branches.isPending && branchList.length > 0}
            value={branchOpen ? branchQuery : baseBranch ?? ''}
            placeholder={branches.isPending ? 'Loading branches...' : 'Search branches'}
            placeholderTextColor={theme.colors.textMuted}
            selectionColor={theme.colors.accent}
            autoCapitalize="none"
            autoCorrect={false}
            onFocus={() => setBranchOpen(true)}
            onBlur={closeBranches}
            onChangeText={setBranchQuery}
            style={[theme.typography.subhead, styles.input, { color: theme.colors.text }]}
          />
          <Icon ios="chevron.down" android="expand_more" size={16} />
        </View>
        {branchOpen ? (
          <Options>
            {matchingBranches.slice(0, VISIBLE_BRANCHES).map(branch => (
              <Option
                key={branch.name}
                testID={`new-pane-branch-${branch.name}`}
                title={branch.name}
                note={branch.isCurrent ? 'current' : undefined}
                selected={branch.name === baseBranch}
                onPress={() => {
                  setChosenBranch(branch.name);
                  branchInput.current?.blur();
                  closeBranches();
                }}
              />
            ))}
            {matchingBranches.length === 0 ? <Text variant="subhead" tone="secondary" style={styles.optionNote}>No branches match.</Text> : null}
            {matchingBranches.length > VISIBLE_BRANCHES ? (
              <Text variant="footnote" tone="muted" style={styles.optionNote}>
                {`${matchingBranches.length - VISIBLE_BRANCHES} more. Search to narrow them down.`}
              </Text>
            ) : null}
          </Options>
        ) : null}
        {branches.isError
          ? <Text testID="new-pane-branch-error" variant="footnote" tone="danger">{branches.error.message}</Text>
          : <Text variant="footnote" tone="muted">Remote branches will track their remote for git pull/push.</Text>}
      </DialogSection>

      <DialogSection>
        <Label>Pane Name</Label>
        <TextInput
          testID="new-pane-name"
          accessibilityLabel="Pane Name"
          value={name}
          placeholder="pane-name"
          placeholderTextColor={theme.colors.textMuted}
          selectionColor={theme.colors.accent}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onChangeText={setEditedName}
          onSubmitEditing={submit}
          style={[theme.typography.body, styles.field, field, { color: theme.colors.text }]}
        />
        <Text variant="footnote" tone="muted">Auto-filled from branch. Edit to customize.</Text>
      </DialogSection>

      <DialogSection>
        <Label ios="sparkles" android="auto_awesome">Agent</Label>
        <View style={[styles.options, { borderRadius: theme.radius.md, borderColor: theme.colors.border }]}>
          {AGENT_LAUNCH_PRESETS.map((preset, index) => (
            <Pressable
              key={preset.id}
              testID={`new-pane-agent-${preset.id}`}
              accessibilityRole="radio"
              accessibilityLabel={preset.title}
              accessibilityState={{ selected: preset.id === agent }}
              onPress={() => setAgent(preset.id)}
              style={({ pressed }) => [
                styles.agent,
                index > 0 && { borderTopWidth: 1, borderColor: theme.colors.border },
                { backgroundColor: preset.id === agent ? theme.colors.selected : pressed ? theme.colors.surfacePressed : theme.colors.surface },
              ]}
            >
              <View style={styles.fill}>
                <Text variant="callout" style={styles.bold}>{preset.title}</Text>
                <Text variant="footnote" tone="muted" numberOfLines={1} style={{ fontFamily: monoFontFamily }}>{preset.command}</Text>
              </View>
              {preset.id === agent ? <Icon ios="checkmark" android="check" size={16} color={theme.colors.accent} /> : null}
            </Pressable>
          ))}
        </View>
      </DialogSection>

      <DialogSection divided={Boolean(error)}>
        <View style={styles.toggle}>
          <Icon ios="pin" android="keep" size={16} />
          <View style={styles.fill}>
            <Text variant="callout" style={styles.bold}>Start pinned</Text>
            <Text variant="subhead" tone="secondary">Show this pane in the pinned section immediately.</Text>
          </View>
          <Switch
            testID="new-pane-pinned"
            accessibilityLabel="Start pinned"
            value={startPinned}
            onValueChange={setStartPinned}
            trackColor={{ true: theme.colors.accent, false: undefined }}
          />
        </View>
      </DialogSection>

      {error ? <View style={styles.error}><Notice testID="new-pane-error" danger message={error} /></View> : null}
    </DialogSheet>
  );
}

/** A dialog section's `text-sm font-semibold` label with its `text-text-tertiary` icon. */
function Label({ ios, android, children }: { ios?: 'folder' | 'arrow.triangle.branch' | 'sparkles'; android?: 'folder' | 'call_split' | 'auto_awesome'; children: string }) {
  return (
    <View style={styles.label}>
      {ios && android ? <Icon ios={ios} android={android} size={16} /> : null}
      <Text variant="callout" style={styles.bold}>{children}</Text>
    </View>
  );
}

/** The combobox's `rounded-md border` option list, inline under the field. */
function Options({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.options, styles.optionList, { borderRadius: theme.radius.md, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
      {children}
    </View>
  );
}

function Option({ title, note, selected, onPress, testID }: { title: string; note?: string; selected: boolean; onPress: () => void; testID: string }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && { backgroundColor: theme.colors.surfacePressed }]}
    >
      <Text variant="subhead" tone={selected ? 'primary' : 'secondary'} numberOfLines={1} style={styles.fill}>{title}</Text>
      {note ? <Text variant="footnote" tone="muted">{note}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bold: { fontWeight: '600' },
  label: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // h-12 rounded-md border bg-surface-secondary px-3.
  field: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 48, paddingHorizontal: 12, borderWidth: 1 },
  input: { flex: 1, height: '100%', paddingVertical: 0 },
  options: { borderWidth: 1, overflow: 'hidden' },
  optionList: { paddingVertical: 4 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  optionNote: { paddingHorizontal: 12, paddingVertical: 8 },
  agent: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  error: { paddingHorizontal: 20, paddingBottom: 20 },
  create: { paddingHorizontal: 20 },
});
