import { useEffect, useState } from 'react';
import { FileText, LayoutTemplate, Pencil, Save } from 'lucide-react';
import { agentLabel } from '../../../../shared/agents';
import type { ProfilePlugin, ProfileSummary } from '../../../../shared/types/profileEditor';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { fileKey, isCoverPlace, shownFile, useProfilesStore } from '../../stores/profilesStore';
import { isMac } from '../../utils/platformUtils';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { TODOS_HEADER_BUTTON } from '../todos/todoStyles';
import { GeneratedCover, HtmlPage, MarkdownWithMeta, YamlPreview } from './ProfilePreviews';
import { findNode, previewKind } from './profilePreview';
import { savedSyncText } from './profileSyncText';
import { isProfilesEnabled, useConfigStore } from '../../stores/configStore';

const MOD = isMac() ? '⌘' : 'Ctrl+';

/** How many Sessions on this computer use one of the plugin's profiles. */
function useSessionsOnPlugin(plugin: ProfilePlugin): number {
  const sessions = useOrchestrationSessionStore(state => state.sessions);
  const refs = new Set(plugin.profiles.map(profile => profile.ref));
  return sessions.filter(session => !session.archived && session.agentProfile && refs.has(session.agentProfile.ref.split(':')[0])).length;
}

/**
 * The right side of the profile page (T-63, build-6 feedback items 3 and 5): the cover page or a
 * file, previewed first. Edit shows its source; ⌘S saves (checked by Agent Farm), Cancel or Esc
 * leaves without saving, asking first when there are edits. A file you have unsaved edits in opens
 * in Edit. The changed-on-disk notice (profileDiskSync.ts) shows here either way.
 */
export function ProfileFilePane({ plugin, profile, file, notify, onShow }: {
  plugin: ProfilePlugin;
  profile: ProfileSummary;
  file: string;
  notify: (text: string) => void;
  /** Shows another row of the tree: a subagent's cover from a cover's chip, or a subagent's profile. */
  onShow: (id: string | null, file: string) => void;
}) {
  const overview = useProfilesStore(state => state.overview);
  const open = useProfilesStore(state => state.open);
  const cover = isCoverPlace(file);
  const coverId = cover ? file.slice('cover:'.length) : '';
  const subagentNode = coverId ? findNode(profile.tree, coverId) : undefined;
  const subagent = subagentNode?.kind === 'subagent' ? subagentNode : undefined;
  // The file on disk this shows: the file, or a cover's own file when it has one.
  const path = shownFile(overview, plugin.name, profile.name, file);
  const key = path ? fileKey(plugin.name, path) : '';
  const saved = useProfilesStore(state => (path ? state.saved[key] : undefined));
  const draft = useProfilesStore(state => (path ? state.drafts[key] : undefined));
  const onDisk = useProfilesStore(state => (path ? state.onDisk[key] : undefined));
  const readFile = useProfilesStore(state => state.readFile);
  const edit = useProfilesStore(state => state.edit);
  const save = useProfilesStore(state => state.save);
  const resolveDiskChange = useProfilesStore(state => state.resolveDiskChange);
  const sessions = useSessionsOnPlugin(plugin);
  const [editing, setEditing] = useState(draft !== undefined);
  const [readError, setReadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Opening a file always reads it again, so a change made outside the tab shows (profileDiskSync.ts).
  // A file with unsaved edits opens in Edit.
  useEffect(() => {
    setReadError(null);
    setSaveError(null);
    setEditing(path ? useProfilesStore.getState().drafts[fileKey(plugin.name, path)] !== undefined : false);
    if (path) readFile(plugin.name, path).catch(error => setReadError(error instanceof Error ? error.message : String(error)));
  }, [path, plugin.name, readFile]);

  const dirty = draft !== undefined;
  const value = draft ?? saved ?? '';

  const runSave = async () => {
    if (!path || !dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await save(plugin.name, path);
      setEditing(false);
      // Where the save goes (PR 6), with the computers reachable right now, so the notice doesn't name one that just went offline (QA F-4).
      let sent = '';
      if (isProfilesEnabled(useConfigStore.getState().config)) {
        await useProfilesStore.getState().loadSync();
        sent = savedSyncText(useProfilesStore.getState().sync);
      }
      notify(`Saved ${plugin.name}/${path}.${sent}${sessions ? ` ${sessions} Session${sessions === 1 ? '' : 's'} can reload it.` : ''}`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (path && saved !== undefined) edit(plugin.name, path, saved);
    setEditing(false);
    setSaveError(null);
  };
  const cancel = () => { if (dirty) setConfirmCancel(true); else discard(); };

  const heading = cover ? (subagent ? subagent.label : 'Cover page') : file;
  const coverNote = cover && path ? `From the ${subagent ? 'subagent’s profile' : 'profile'}: ${path}` : null;
  const status = dirty
    ? 'Unsaved changes'
    : plugin.bundled
      ? plugin.edited ? 'Edited: Pane updates won’t replace your copy' : 'Ships with Pane. Saving makes it yours on this computer'
      : `${agentLabel(profile.harness)}${profile.model ? ` · ${profile.model}` : ''}`;

  let body;
  if (readError && saved === undefined) body = <p role="alert" className="p-4 text-[13px] text-status-error">{readError}</p>;
  else if (editing && path) {
    body = (
      <textarea
        aria-label={`Edit ${plugin.name}/${path}`}
        data-testid="profiles-editor"
        spellCheck={false}
        autoFocus
        value={value}
        disabled={saved === undefined}
        onChange={event => edit(plugin.name, path, event.target.value)}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            void runSave();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
        className="min-h-0 flex-1 resize-none bg-bg-primary px-4 py-3 font-mono text-[13px] leading-[1.55] text-text-primary focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-interactive)]"
      />
    );
  } else if (cover && !path) {
    body = <GeneratedCover plugin={plugin.name} profile={profile} subagent={subagent} onOpenSubagent={id => onShow(id, `cover:${id}`)} />;
  } else if (saved === undefined || !path) body = <div className="flex-1" />;
  else {
    const kind = previewKind(path);
    body = kind === 'html' ? <HtmlPage html={value} title={`${plugin.name}/${path}`} />
      : kind === 'markdown' ? <MarkdownWithMeta source={value} />
        : kind === 'yaml' ? <YamlPreview source={value} />
          : <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-6 py-4 font-mono text-[12.5px] text-text-primary" data-testid="profiles-text-preview">{value}</pre>;
  }

  const subagentProfile = subagent?.profile ? plugin.profiles.find(item => item.ref === subagent.profile) : undefined;
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="profiles-editor-pane">
      <div className="flex h-[44px] shrink-0 items-center gap-2 border-b border-border-primary px-4">
        {cover ? <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />}
        <span className={cover ? 'truncate text-[13.5px] font-semibold' : 'truncate font-mono text-[13px] font-semibold'} data-testid="profiles-path">{heading}</span>
        <span className="flex-1" />
        {subagentProfile && !editing && (
          <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-open-subagent-profile" onClick={() => open(plugin.name, subagentProfile.name)}>Open its profile</button>
        )}
        {path && !editing && (
          <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-edit" onClick={() => setEditing(true)} disabled={saved === undefined}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit
          </button>
        )}
        {path && editing && (
          <>
            <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-cancel" onClick={cancel}>Cancel</button>
            <Button size="sm" onClick={() => { void runSave(); }} disabled={!dirty || saving} data-testid="profiles-save" title={`Save (${MOD}S)`}>
              <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
      </div>
      {coverNote && <div className="shrink-0 border-b border-border-primary px-4 py-1.5 text-[12px] text-text-secondary" data-testid="profiles-cover-note">{coverNote}</div>}
      {path && onDisk !== undefined && (
        <div role="status" data-testid="profiles-disk-changed" className="flex shrink-0 items-center gap-3 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-[13px] text-text-primary">
          <span className="min-w-0 flex-1">
            {onDisk === null
              ? 'This file was removed outside Pane. Your unsaved edits are still here; Save puts the file back.'
              : 'This file changed outside Pane while you were editing. Reload it, or keep your edits (Save then replaces the other version).'}
          </span>
          <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-disk-reload" onClick={() => resolveDiskChange(plugin.name, path, 'disk')}>
            {onDisk === null ? 'Discard my edits' : 'Reload from disk'}
          </button>
          <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-disk-keep" onClick={() => resolveDiskChange(plugin.name, path, 'mine')}>Keep mine</button>
        </div>
      )}
      {body}
      {saveError && <p role="alert" className="border-t border-border-primary px-4 py-2 text-[12.5px] text-status-error" data-testid="profiles-save-error">{saveError}</p>}
      {editing && <div className="flex h-[34px] shrink-0 items-center border-t border-border-primary px-4 text-[12px] text-text-secondary" data-testid="profiles-editor-status">{status}</div>}
      <ConfirmDialog
        isOpen={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={discard}
        title="Discard your edits?"
        message={`Your unsaved edits to ${plugin.name}/${path ?? ''} will be lost.`}
        confirmText="Discard"
        variant="danger"
      />
    </div>
  );
}
