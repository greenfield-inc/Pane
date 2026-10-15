import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { Input } from './ui/Input';
import { Button, IconButton } from './ui/Button';
import { cn } from '../utils/cn';
import { emptyProjectEnvRow, projectEnvRowProblem, type ProjectEnvRow } from './projectEnvRows';

interface ProjectEnvVarsSectionProps {
  rows: ProjectEnvRow[];
  onChange: (rows: ProjectEnvRow[]) => void;
}

function Segment<Value extends string>({ value, options, onChange, label }: {
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-md border border-border-primary bg-surface-secondary p-0.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 w-28 rounded text-xs font-medium transition-colors',
            value === option.value ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-secondary',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Project Settings → Environment Variables. Keychain values are write-only: a saved secret is never shown. */
export function ProjectEnvVarsSection({ rows, onChange }: ProjectEnvVarsSectionProps) {
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
          const problem = row.key.trim() || row.value || row.secret || row.service || row.account
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
                <Segment
                  label={`Where ${row.key || 'this variable'} comes from`}
                  value={row.source}
                  onChange={(source) => update(row.id, { source })}
                  options={[
                    { value: 'plain', label: 'Plain text' },
                    { value: 'keychain', label: 'macOS Keychain' },
                  ]}
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

              {row.source === 'keychain' && (
                <div className="space-y-2">
                  {row.keychainMode === 'stored' ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                      <span className="font-mono tracking-widest text-text-tertiary" aria-hidden="true">••••••••</span>
                      <span>Stored in Pane&apos;s keychain item</span>
                      <span className="font-mono text-xs text-text-tertiary">{row.service} / {row.account}</span>
                      <Button type="button" variant="secondary" size="sm" onClick={() => update(row.id, { keychainMode: 'secret', secret: '' })}>
                        Replace
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Segment
                        label={`How ${row.key || 'this variable'} uses the keychain`}
                        value={row.keychainMode}
                        onChange={(keychainMode) => update(row.id, { keychainMode })}
                        options={[
                          { value: 'secret', label: 'New secret' },
                          { value: 'reference', label: 'Existing item' },
                        ]}
                      />
                      {row.keychainMode === 'secret' ? (
                        <Input
                          type="password"
                          autoComplete="off"
                          aria-label={`Secret value of ${row.key || 'variable'}`}
                          value={row.secret}
                          onChange={(e) => update(row.id, { secret: e.target.value })}
                          placeholder="Pane stores this in your keychain"
                          className="font-mono text-sm"
                          fullWidth
                        />
                      ) : (
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
                    </>
                  )}
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
