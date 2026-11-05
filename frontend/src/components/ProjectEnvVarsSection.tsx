import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { Input } from './ui/Input';
import { Button, IconButton } from './ui/Button';
import { SegmentedControl } from './settings/SettingsControls';
import { isMac } from '../utils/platformUtils';
import { emptyProjectEnvRow, projectEnvRowProblem, rowSecretAddress, type ProjectEnvRow } from './projectEnvRows';

interface ProjectEnvVarsSectionProps {
  rows: ProjectEnvRow[];
  onChange: (rows: ProjectEnvRow[]) => void;
  /** The secret project a new Pane secret row defaults to: the repo's name, made valid. */
  defaultProject: string;
}

const SOURCE_OPTIONS = [
  { id: 'plain', label: 'Plain text' },
  { id: 'secret', label: 'Pane secret' },
  { id: 'keychain', label: 'macOS Keychain' },
] as const;

/** Keychain items exist only on macOS; a row saved with one elsewhere still shows it. */
function sourceOptions(row: ProjectEnvRow) {
  return isMac() || row.source === 'keychain' ? SOURCE_OPTIONS : SOURCE_OPTIONS.filter(option => option.id !== 'keychain');
}

/** Project Settings → Environment Variables. Secret and keychain values are write-only: a saved value is never shown. */
export function ProjectEnvVarsSection({ rows, onChange, defaultProject }: ProjectEnvVarsSectionProps) {
  const secretLabel = (row: ProjectEnvRow) => {
    const { project, name } = rowSecretAddress(row, defaultProject);
    return `${project}/${name || 'NAME'}`;
  };
  const update = (id: string, patch: Partial<ProjectEnvRow>) => {
    onChange(rows.map(row => row.id === id ? { ...row, ...patch } : row));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 pb-3 border-b border-border-primary">
        <KeyRound className="w-5 h-5 text-interactive" />
        <div>
          <h3 className="text-heading-3 font-semibold text-text-primary">Environment Variables</h3>
          <p className="text-sm text-text-tertiary">
            Set in this project&apos;s terminals, agents, and setup, run and archive scripts. Applies to terminals opened after you save.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {rows.length === 0 && (
          <p className="text-sm text-text-tertiary">No variables. Pane&apos;s own variables (PATH, WORKTREE_PATH, PANE_*) are always set.</p>
        )}
        {rows.map((row, index) => {
          const options = sourceOptions(row);
          const problem = row.key.trim() || row.value || row.secretProject || row.secretName || row.secretValue || row.service || row.account
            ? projectEnvRowProblem(row, rows.slice(0, index))
            : null;
          return (
            <div key={row.id} className="rounded-lg border border-border-primary bg-surface-secondary/30 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[12rem] flex-1">
                  <Input
                    aria-label="Variable name"
                    value={row.key}
                    onChange={(e) => update(row.id, { key: e.target.value })}
                    placeholder="API_KEY"
                    className="font-mono text-sm"
                    fullWidth
                  />
                </div>
                <SegmentedControl
                  label={`Where ${row.key || 'this variable'} comes from`}
                  value={row.source}
                  onChange={(source) => update(row.id, { source })}
                  options={options}
                  columns={options.length === 3 ? 3 : 2}
                />
                <IconButton
                  type="button"
                  variant="ghost"
                  size="md"
                  aria-label={`Remove ${row.key || 'variable'}`}
                  onClick={() => onChange(rows.filter(other => other.id !== row.id))}
                  icon={<Trash2 className="w-4 h-4" />}
                />
              </div>

              {row.source === 'plain' && (
                <Input
                  aria-label={`Value of ${row.key || 'variable'}`}
                  value={row.value}
                  onChange={(e) => update(row.id, { value: e.target.value })}
                  placeholder="value"
                  className="font-mono text-sm"
                  fullWidth
                />
              )}

              {row.source === 'secret' && (
                row.secretStored ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                    <span className="font-mono tracking-widest text-text-tertiary" aria-hidden="true">••••••••</span>
                    <span>Pane secret <span className="font-mono">{secretLabel(row)}</span></span>
                    <Button type="button" variant="secondary" size="sm" onClick={() => update(row.id, { secretStored: false, secretValue: '' })}>
                      Replace
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <div className="min-w-[10rem] flex-1">
                        <Input
                          aria-label="Secret project"
                          value={row.secretProject}
                          onChange={(e) => update(row.id, { secretProject: e.target.value })}
                          placeholder={`Project: ${defaultProject}`}
                          className="font-mono text-sm"
                          fullWidth
                        />
                      </div>
                      <div className="min-w-[10rem] flex-1">
                        <Input
                          aria-label="Secret name"
                          value={row.secretName}
                          onChange={(e) => update(row.id, { secretName: e.target.value })}
                          placeholder={`Name: ${row.key.trim() || 'NAME'}`}
                          className="font-mono text-sm"
                          fullWidth
                        />
                      </div>
                    </div>
                    <Input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={`Secret value of ${row.key || 'variable'}`}
                      value={row.secretValue}
                      onChange={(e) => update(row.id, { secretValue: e.target.value })}
                      placeholder={`Type a value to save it as ${secretLabel(row)}, or leave empty to use the saved one`}
                      className="font-mono text-sm"
                      fullWidth
                    />
                  </div>
                )
              )}

              {row.source === 'keychain' && (
                <div className="flex flex-wrap gap-2">
                  <div className="min-w-[10rem] flex-1">
                    <Input
                      aria-label="Keychain service"
                      value={row.service}
                      onChange={(e) => update(row.id, { service: e.target.value })}
                      placeholder="Service (Where)"
                      className="font-mono text-sm"
                      fullWidth
                    />
                  </div>
                  <div className="min-w-[10rem] flex-1">
                    <Input
                      aria-label="Keychain account"
                      value={row.account}
                      onChange={(e) => update(row.id, { account: e.target.value })}
                      placeholder="Account"
                      className="font-mono text-sm"
                      fullWidth
                    />
                  </div>
                </div>
              )}

              {problem && <p className="text-xs text-status-error">{problem}</p>}
            </div>
          );
        })}

        <Button type="button" variant="secondary" size="sm" icon={<Plus className="w-4 h-4" />} onClick={() => onChange([...rows, emptyProjectEnvRow()])}>
          Add variable
        </Button>
      </div>
    </div>
  );
}
