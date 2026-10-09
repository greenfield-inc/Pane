/**
 * Opens a file as a center `editor` tab with VS Code preview semantics.
 *
 * - A single click opens a *preview* tab (italic title). There is at most one
 *   preview tab per session; the next single-click re-targets it.
 * - `pin: true` (double-click, "Open in editor", terminal links) opens a
 *   pinned tab, or pins the preview tab if it already shows this file.
 * - A file that is already open in any editor tab is focused, not duplicated.
 */
import type { EditorDiffRef, EditorPanelState, SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';
import { diffRefLabel, sameDiffRef } from '../components/panels/diff/diffScope';
import { panelApi } from './panelApi';
import { usePanelStore } from '../stores/panelStore';
import { useConfigStore } from '../stores/configStore';
import { rememberPaneLayout } from '../utils/paneLayoutMemory';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { addPanelToGroup, findGroup, findGroupContainingPanel, primaryGroup } from '../utils/panelLayout';

export interface OpenFileInEditorOptions {
  sessionId: string;
  filePath: string;
  /** Pin the tab (VS Code double-click). Defaults to a preview tab. */
  pin?: boolean;
  cursorPosition?: { line: number; column: number };
  /** Open the file's diff (Review panel) instead of the editable file. */
  diff?: EditorDiffRef;
}

/** IPC payloads are JSON: an explicit `undefined` is rejected at the boundary. */
function withoutUndefined(state: EditorPanelState): EditorPanelState {
  const clean = { ...state };
  // SAFETY: `clean` is a shallow copy of an EditorPanelState, so its keys are that type's keys.
  for (const key of Object.keys(clean) as (keyof EditorPanelState)[]) {
    if (clean[key] === undefined) delete clean[key];
  }
  return clean;
}

export function editorPanelState(panel: ToolPanel): EditorPanelState | undefined {
  if (panel.type !== 'editor') return undefined;
  // SAFETY: The panel type discriminator determines the custom-state shape.
  return panel.state?.customState as EditorPanelState | undefined;
}

export function editorTitleFor(filePath: string, isDirty?: boolean, diff?: EditorDiffRef): string {
  const name = filePath.split(/[/\\]/).pop() || 'Editor';
  if (diff) return `${name} (${diffRefLabel(diff)})`;
  return isDirty ? `${name} *` : name;
}

/** Same file *and* same diff context (an editor tab and a diff tab can coexist). */
function showsTarget(panel: ToolPanel, filePath: string, diff: EditorDiffRef | undefined): boolean {
  const state = editorPanelState(panel);
  return state?.filePath === filePath && sameDiffRef(state.diff, diff);
}

/** Point the session's layout at `panelId`, inserting it if it is new. */
function revealInLayout(sessionId: string, panelId: string): void {
  const store = usePanelStore.getState();
  const layout = store.layouts[sessionId];
  if (!layout) return;

  let root = layout.root;
  let group = findGroupContainingPanel(root, panelId);
  if (group) {
    const groupId = group.id;
    const setActive = (node: SessionPanelLayout['root']): SessionPanelLayout['root'] => {
      if (node.type === 'group') return node.id === groupId ? { ...node, activePanelId: panelId } : node;
      return { ...node, children: node.children.map(setActive) };
    };
    root = setActive(root);
  } else {
    const focusedGid = store.focusedGroupIds[sessionId];
    group = (focusedGid && findGroup(root, focusedGid)) || primaryGroup(root);
    root = addPanelToGroup(root, group.id, panelId);
  }

  const next: SessionPanelLayout = { ...layout, root, focusedGroupId: group.id };
  store.setLayout(sessionId, next);
  store.setFocusedGroup(sessionId, group.id);
  // The host keeps it as the last-used layout; this desktop keeps its own.
  panelApi.setLayout(sessionId, next).catch(() => {});
  const config = useConfigStore.getState().config;
  rememberPaneLayout(config ? getActiveRemoteHostId(config.remoteDaemon) : undefined, sessionId, next);
}

async function activate(sessionId: string, panelId: string): Promise<void> {
  usePanelStore.getState().setActivePanel(sessionId, panelId);
  revealInLayout(sessionId, panelId);
  await panelApi.setActivePanel(sessionId, panelId);
}

/** Persist a pin / retarget on an existing editor tab. */
async function updateEditorPanel(
  panel: ToolPanel,
  patch: Partial<EditorPanelState>,
  title?: string,
): Promise<ToolPanel> {
  const current = editorPanelState(panel) ?? { filePath: '' };
  const updated: ToolPanel = {
    ...panel,
    title: title ?? panel.title,
    state: { ...panel.state, customState: withoutUndefined({ ...current, ...patch }) },
  };
  usePanelStore.getState().updatePanelState(updated);
  await panelApi.updatePanel(panel.id, { title: updated.title, state: updated.state });
  return updated;
}

export async function pinEditorPanel(panel: ToolPanel): Promise<void> {
  if (!editorPanelState(panel)?.isPreview) return;
  await updateEditorPanel(panel, { isPreview: false });
}

export async function openFileInEditor(options: OpenFileInEditorOptions): Promise<ToolPanel> {
  const { sessionId, filePath, pin = false, cursorPosition, diff } = options;
  const store = usePanelStore.getState();
  const editors = store.getSessionPanels(sessionId).filter((p) => p.type === 'editor');

  // Already open: focus it (and pin on request).
  const existing = editors.find((p) => showsTarget(p, filePath, diff));
  if (existing) {
    let panel = existing;
    const patch: Partial<EditorPanelState> = {};
    if (pin && editorPanelState(existing)?.isPreview) patch.isPreview = false;
    // Persist the requested position: a background tab mounts its editor only
    // once activated, and restores the cursor from panel state on mount.
    if (cursorPosition) {
      patch.cursorPosition = cursorPosition;
      // A stale scroll offset would win over the cursor reveal on mount.
      patch.scrollPosition = undefined;
    }
    if (Object.keys(patch).length > 0) panel = await updateEditorPanel(existing, patch);
    await activate(sessionId, panel.id);
    // An already-mounted editor will not remount, so ask it to move directly.
    // Dispatched after activation so a freshly mounted view has its listener.
    if (cursorPosition) {
      window.dispatchEvent(new CustomEvent('editor-panel:reveal', {
        detail: { panelId: panel.id, filePath, cursorPosition },
      }));
    }
    return panel;
  }

  // Preview click with a preview tab present: re-target that tab.
  const preview = editors.find((p) => editorPanelState(p)?.isPreview);
  if (!pin && preview) {
    const panel = await updateEditorPanel(
      preview,
      { filePath, diff, isPreview: true, isDirty: false, cursorPosition, scrollPosition: undefined },
      editorTitleFor(filePath, false, diff),
    );
    await activate(sessionId, panel.id);
    return panel;
  }

  const created = await panelApi.createPanel({
    sessionId,
    type: 'editor',
    title: editorTitleFor(filePath, false, diff),
    initialState: { customState: withoutUndefined({ filePath, diff, isPreview: !pin, isDirty: false, cursorPosition }) },
  });
  store.addPanel(created);
  await activate(sessionId, created.id);
  return created;
}
