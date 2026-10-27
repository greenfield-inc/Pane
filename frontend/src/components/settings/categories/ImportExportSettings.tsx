import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowUpFromLine, Box, Check, ChevronDown, ChevronRight, Download, Info } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsPage } from '../SettingRow';
import { settingDomId } from '../catalog';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { SETUP_SECTION_LABELS, applySetupImport, setupErrorText } from '../setupTransfer';
import { API, type IPCResponse } from '../../../utils/api';
import { cn } from '../../../utils/cn';
import { getThemeLabel } from '../../../utils/themeOptions';
import { capture } from '../../../services/posthog';
import { useConfigStore } from '../../../stores/configStore';
import { useRemoteRuntimeState } from '../../../hooks/useRemoteRuntimeState';
import { parseSettingsPreferences, type SettingsPreferenceValues } from '../../../types/settings';
import {
  SETUP_SECTION_IDS,
  type SetupExportResult,
  type SetupExportRow,
  type SetupExportSummary,
  type SetupImportPreview,
  type SetupPreferenceKey,
  type SetupPreviewSection,
  type SetupSectionId,
} from '../../../../../shared/types/setupTransfer';

export type SetupNotice =
  | { kind: 'saved'; result: SetupExportResult }
  | { kind: 'imported'; message: string }
  | { kind: 'error'; message: string };

const PREFERENCE_NAME_BY_KEY = {
  auto_rename_sessions_to_pr: 'autoRenameSessionsToPr',
  sidebar_pane_row_layout: 'sidebarPaneRowLayout',
  sidebar_attention_inbox: 'sidebarAttentionInbox',
  at_terminal_paste_mode: 'atTerminalPasteMode',
  at_terminal_line_count: 'atTerminalLineCount',
} satisfies Record<SetupPreferenceKey, keyof SettingsPreferenceValues>;

const osName = (platform: string) => {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return platform === 'linux' ? 'Linux' : platform;
};
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function exportMeta(row: SetupExportRow): string {
  switch (row.id) {
    case 'agentPresets':
      return row.agents?.join(' · ') ?? '';
    case 'runScripts':
      return plural(row.count, 'repository', 'repositories');
    case 'worktreeFileSync':
      return plural(row.count, 'path');
    case 'skills': {
      const on = [row.skills?.homeSkill && 'Pane skill', row.skills?.registerMcp && 'MCP on'].filter(Boolean);
      return on.length ? on.join(' · ') : 'Off';
    }
    case 'appearance':
      if (!row.appearance) return '';
      return row.appearance.mode === 'system'
        ? `${getThemeLabel(row.appearance.light)} / ${getThemeLabel(row.appearance.dark)}`
        : getThemeLabel(row.appearance.theme);
    case 'preferences':
      return plural(row.count, 'setting');
    default:
      return String(row.count);
  }
}

const SKILL_PHRASES = {
  'mcp-on': 'Turns on MCP',
  'mcp-off': 'Turns off MCP',
  'skill-on': 'Turns on Pane skill',
  'skill-off': 'Turns off Pane skill',
  toolsets: 'Changes MCP toolsets',
} as const;

function previewMeta(section: SetupPreviewSection, preview: SetupImportPreview): string {
  if (section.changes === 0) {
    const skipped = section.items.filter((item) => item.kind === 'skipped').length;
    return skipped > 0 ? `No changes · ${skipped} skipped` : 'No changes';
  }
  switch (section.id) {
    case 'customCommands':
    case 'terminalShortcuts':
    case 'worktreeFileSync':
      return [
        section.added && `${section.added} new`,
        section.replaced && `${section.replaced} replaces`,
        section.keyInUse && `${section.keyInUse} key in use`,
      ].filter(Boolean).join(' · ');
    case 'runScripts': {
      const { matched = 0, total = 0 } = section.repositories ?? {};
      const here = `${matched} of ${plural(total, 'repository', 'repositories')} here`;
      return preview.otherPlatform ? `${here} · written on ${osName(preview.platform)}` : here;
    }
    case 'skills':
      return (section.skills ?? []).map((phrase) => SKILL_PHRASES[phrase]).join(' · ');
    case 'appearance':
      return section.theme ? getThemeLabel(section.theme) : plural(section.changes, 'change');
    default:
      return plural(section.changes, 'change');
  }
}

const bold = (name: string) => <b className="font-semibold text-text-primary">{name}</b>;

function Names({ names }: { names: readonly string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <Fragment key={name}>
          {index > 0 && (index === names.length - 1 ? ' and ' : ', ')}
          {bold(name)}
        </Fragment>
      ))}
    </>
  );
}

function NoticeLine({ notice, platform, onShowFile }: { notice: SetupNotice; platform: string; onShowFile: (path: string) => void }) {
  if (notice.kind === 'error') {
    return (
      <p className="flex items-start gap-2 text-xs leading-relaxed text-status-error" role="alert">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" /> <span>{notice.message}</span>
      </p>
    );
  }
  let body: ReactNode = notice.kind === 'imported' ? notice.message : null;
  if (notice.kind === 'saved') {
    const leftOut = notice.result.leftOut.map((item) => item.name);
    body = (
      <>
        Saved <Names names={[notice.result.fileName]} />.
        {leftOut.length > 0 && (
          <> Left out <Names names={leftOut} /> because {leftOut.length === 1 ? 'it looks like it contains' : 'they look like they contain'} a token.</>
        )}{' '}
        <button type="button" className="text-interactive hover:underline" onClick={() => onShowFile(notice.result.filePath)}>
          {platform === 'darwin' ? 'Show in Finder' : 'Show in folder'}
        </button>
      </>
    );
  }
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-text-secondary" aria-live="polite">
      <Check className="mt-0.5 h-3.5 w-3.5 flex-none text-status-success" /> <span>{body}</span>
    </p>
  );
}

interface SetupRowProps {
  id: SetupSectionId;
  checked: boolean;
  disabled: boolean;
  dimmed?: boolean;
  meta: ReactNode;
  onToggle: () => void;
  /** The chevron stays usable on a row with nothing to import, so its skip reasons can be read. */
  expandDisabled?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
}

function SetupRow({ id, checked, disabled, dimmed, meta, onToggle, expandDisabled, expanded, onExpand }: SetupRowProps) {
  const label = SETUP_SECTION_LABELS[id];
  const metaId = `setup-row-${id}-meta`;
  return (
    <div className={cn('flex items-center rounded-lg border border-border-secondary bg-surface-secondary', dimmed && 'opacity-50')}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        aria-describedby={metaId}
        disabled={disabled}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-text-primary enabled:hover:bg-surface-hover disabled:cursor-not-allowed"
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
            checked ? 'border-status-success bg-status-success text-text-on-status-success' : 'border-text-muted',
          )}
        >
          {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
        <span className="truncate">{label}</span>
        <span id={metaId} className="ml-auto truncate pl-3 text-xs text-text-tertiary">{meta}</span>
      </button>
      {onExpand && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} ${label} changes`}
          disabled={expandDisabled ?? disabled}
          onClick={onExpand}
          className="mr-2 flex h-6 w-6 flex-none items-center justify-center rounded text-text-tertiary enabled:hover:bg-surface-hover enabled:hover:text-text-secondary"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}

function PreviewItems({ section }: { section: SetupPreviewSection }) {
  return (
    <ul className="mb-1 ml-9 space-y-0.5 text-xs leading-relaxed text-text-secondary">
      {section.items.map((item, index) => (
        <li key={`${item.kind}-${item.name}-${index}`}>
          {item.kind === 'skipped' ? (
            <span className="text-text-tertiary">{item.field ? `${item.name} ${item.field}` : item.name} · {item.reason}, skipped</span>
          ) : (
            <>
              <span className={item.kind === 'new' ? 'text-status-success' : 'text-status-warning'}>
                {item.kind === 'new' ? 'New' : 'Replaces'}
              </span>{' '}
              {item.name}
              {item.field && <span className="text-text-tertiary"> · {item.field}</span>}
              <span className="ml-1.5 inline-flex flex-col align-top">
                <span className="break-all font-mono text-text-tertiary">
                  {item.text}
                  {item.keyInUse && <span className="font-sans text-status-warning"> · key in use</span>}
                </span>
                {item.was !== undefined && <span className="break-all font-mono text-text-tertiary">was {item.was}</span>}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface SetupCardProps {
  platform: string;
  summary: SetupExportSummary | null;
  /** Shown instead of the export rows while an import is being reviewed. */
  preview: SetupImportPreview | null;
  selected: ReadonlySet<SetupSectionId>;
  expanded: ReadonlySet<SetupSectionId>;
  notice: SetupNotice | null;
  busy: boolean;
  /** The remote host's name while the window is connected to one; the card is disabled then. */
  remoteHost: string | null;
  onToggle: (id: SetupSectionId) => void;
  onExpand: (id: SetupSectionId) => void;
  onExport: () => void;
  onImport: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onShowFile: (path: string) => void;
}

export function SetupCard(props: SetupCardProps) {
  const { platform, summary, preview, selected, expanded, notice, busy, remoteHost } = props;
  const disabled = busy || remoteHost !== null;
  const importable = preview?.sections.filter((section) => section.changes > 0 && selected.has(section.id)).length ?? 0;

  return (
    <div id={settingDomId('setup-transfer')} tabIndex={-1} className="mx-auto w-full max-w-xl space-y-3 outline-none">
      {remoteHost !== null && (
        <p className="flex items-start gap-2 text-sm leading-relaxed text-text-secondary">
          <Info className="mt-0.5 h-4 w-4 flex-none text-text-tertiary" />
          <span>
            You&apos;re connected to <b className="font-semibold text-text-primary">{remoteHost}</b>. Choose{' '}
            <b className="font-semibold text-text-primary">This computer</b> in the sidebar&apos;s host switcher to export or import this computer&apos;s setup.
          </span>
        </p>
      )}
      <div
        aria-disabled={remoteHost !== null || undefined}
        className={cn('space-y-2.5 rounded-xl border border-border-secondary bg-surface-primary p-4', remoteHost !== null && 'opacity-60')}
      >
        <div>
          <div className="flex items-center gap-2">
            {preview
              ? <ArrowUpFromLine className="h-4 w-4 flex-none text-interactive" />
              : <Box className="h-4 w-4 flex-none text-interactive" />}
            <h3 className="truncate text-sm font-semibold text-text-primary">
              {preview ? `Import ${preview.fileName}` : 'Export your Pane setup'}
            </h3>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-text-tertiary">
            {preview
              ? `From Pane ${preview.appVersion} on ${osName(preview.platform)}. Nothing is removed, and nothing changes until you import.`
              : 'Saved as a file you can import into Pane on another computer. Keys and tokens Pane stores are never included.'}
          </p>
        </div>

        <div className="space-y-1.5">
          {preview
            ? preview.sections.map((section) => {
              const empty = section.changes === 0;
              const open = expanded.has(section.id);
              return (
                <Fragment key={section.id}>
                  <SetupRow
                    id={section.id}
                    checked={!empty && selected.has(section.id)}
                    disabled={disabled || empty}
                    expandDisabled={disabled}
                    dimmed={empty}
                    meta={previewMeta(section, preview)}
                    onToggle={() => props.onToggle(section.id)}
                    expanded={open}
                    onExpand={section.items.length > 0 ? () => props.onExpand(section.id) : undefined}
                  />
                  {open && <PreviewItems section={section} />}
                </Fragment>
              );
            })
            : SETUP_SECTION_IDS.map((id) => {
              const row = summary?.rows.find((candidate) => candidate.id === id);
              return (
                <SetupRow
                  key={id}
                  id={id}
                  checked={selected.has(id)}
                  disabled={disabled}
                  meta={row && (
                    <>
                      {exportMeta(row)}
                      {row.leftOut.length > 0 && <span className="text-status-warning"> · {row.leftOut.length} left out</span>}
                    </>
                  )}
                  onToggle={() => props.onToggle(id)}
                />
              );
            })}
        </div>

        {notice && <NoticeLine notice={notice} platform={platform} onShowFile={props.onShowFile} />}

        <div className="flex justify-end gap-2 pt-0.5">
          {preview ? (
            <>
              <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={props.onCancel}>Cancel</Button>
              <Button type="button" size="sm" disabled={disabled || importable === 0} loading={busy} loadingText="Importing" onClick={props.onConfirm}>
                Import {plural(importable, 'section')}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="secondary" size="sm" disabled={disabled} icon={<ArrowUpFromLine className="h-3.5 w-3.5" />} onClick={props.onImport}>
                Import…
              </Button>
              <Button type="button" size="sm" disabled={disabled || selected.size === 0} icon={<Download className="h-3.5 w-3.5" />} onClick={props.onExport}>
                Export…
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

async function settle<T>(work: () => Promise<IPCResponse<T>>, fallback: string): Promise<{ data: T | undefined } | { error: string }> {
  try {
    const response = await work();
    return response.success ? { data: response.data } : { error: setupErrorText(response.error ?? fallback) };
  } catch (error) {
    return { error: error instanceof Error && error.message ? error.message : fallback };
  }
}

const showFileInFolder = (path: string) => {
  void window.electronAPI.invoke('app:showItemInFolder', path).catch(() => undefined);
};

const toggled = (set: ReadonlySet<SetupSectionId>, id: SetupSectionId) => {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
};

export function ImportExportSettings({ persistence, platform }: { persistence: SettingsPersistence; platform: string }) {
  const { connectionState, connectionKnown } = useRemoteRuntimeState();
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const remote = connectionState.mode === 'remote';
  const [summary, setSummary] = useState<SetupExportSummary | null>(null);
  const [preview, setPreview] = useState<SetupImportPreview | null>(null);
  const [exportSelected, setExportSelected] = useState<ReadonlySet<SetupSectionId>>(() => new Set(SETUP_SECTION_IDS));
  const [importSelected, setImportSelected] = useState<ReadonlySet<SetupSectionId>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<SetupSectionId>>(() => new Set());
  const [notice, setNotice] = useState<SetupNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const shownPreview = remote ? null : preview;

  const loadSummary = useCallback(async () => {
    const result = await settle(() => API.setup.summary(), 'Pane could not read this computer\'s setup.');
    if ('error' in result) setNotice({ kind: 'error', message: result.error });
    else if (result.data) setSummary(result.data);
  }, []);

  useEffect(() => {
    if (connectionKnown) void loadSummary();
    // Reload when the window's host or any setting changes, so row summaries stay current.
  }, [connectionKnown, loadSummary, remote, persistence.config]);

  const runExport = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await settle(() => API.setup.export(SETUP_SECTION_IDS.filter((id) => exportSelected.has(id))), 'Pane could not save the file.');
      if ('error' in result) setNotice({ kind: 'error', message: result.error });
      else if (result.data) setNotice({ kind: 'saved', result: result.data });
    } finally {
      setBusy(false);
    }
  };

  const chooseImport = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await settle(() => API.setup.chooseImport(), 'Pane could not read the file.');
      if ('error' in result) {
        setNotice({ kind: 'error', message: result.error });
      } else if (result.data) {
        setPreview(result.data);
        const changed = new Set<SetupSectionId>();
        for (const section of result.data.sections) if (section.changes > 0) changed.add(section.id);
        setImportSelected(changed);
        setExpanded(new Set());
      }
    } finally {
      setBusy(false);
    }
  };

  const savePreference = <K extends keyof SettingsPreferenceValues>(name: K, raw: Record<string, string>) =>
    persistence.savePreference(name, parseSettingsPreferences(raw)[name]);

  const confirmImport = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const outcome = await applySetupImport(preview, importSelected, {
        preview: (file, fileName) => API.setup.preview(file, fileName),
        updateConfig,
        savePreference: (key, value) => savePreference(PREFERENCE_NAME_BY_KEY[key], { [key]: value }),
        updateProject: (projectId, updates) => API.projects.update(projectId, updates),
        capture,
      });
      setPreview(null);
      setNotice({ kind: outcome.kind === 'success' ? 'imported' : 'error', message: outcome.message });
    } finally {
      setBusy(false);
    }
    await loadSummary();
  };

  return (
    <SettingsPage title="Import & Export" description="Move your Pane setup between computers.">
      <SetupCard
        platform={platform}
        summary={summary}
        preview={shownPreview}
        selected={shownPreview ? importSelected : exportSelected}
        expanded={expanded}
        notice={notice}
        busy={busy}
        remoteHost={remote ? connectionState.activeProfileLabel ?? 'a remote host' : null}
        onToggle={(id) => (shownPreview ? setImportSelected : setExportSelected)((current) => toggled(current, id))}
        onExpand={(id) => setExpanded((current) => toggled(current, id))}
        onExport={() => void runExport()}
        onImport={() => void chooseImport()}
        onCancel={() => setPreview(null)}
        onConfirm={() => void confirmImport()}
        onShowFile={showFileInFolder}
      />
    </SettingsPage>
  );
}
