import { useMemo } from 'react';
import { GitBranch, Terminal, Folder, Zap, MessageSquare, Settings, Bell, History } from 'lucide-react';
import { Modal, ModalHeader, ModalBody } from './ui/Modal';
import type { ShortcutCategory } from '../../../shared/constants/keyboardShortcuts';
import { useConfigStore } from '../stores/configStore';
import { CATEGORY_LABELS, CATEGORY_ORDER, formatKeyDisplay } from '../utils/hotkeyUtils';
import { rendererPlatform } from '../utils/platformUtils';
import { buildShortcutMap, REFERENCE_ROWS, type ShortcutMapRow } from '../utils/shortcutMap';
import { Kbd } from './ui/Kbd';

function KeyboardShortcutsSection() {
  const config = useConfigStore((s) => s.config);
  const { rows } = useMemo(() => buildShortcutMap({
    overridesRaw: config?.keyboardShortcutOverrides,
    terminalShortcuts: config?.terminalShortcuts,
    customCommands: config?.customCommands,
    environment: rendererPlatform(),
  }), [config?.keyboardShortcutOverrides, config?.terminalShortcuts, config?.customCommands]);

  const grouped = useMemo(() => {
    const byCategory = new Map<ShortcutCategory, ShortcutMapRow[]>();
    for (const row of rows) {
      const group = byCategory.get(row.category) ?? [];
      group.push(row);
      byCategory.set(row.category, group);
    }
    return CATEGORY_ORDER.flatMap((category) => {
      const group = byCategory.get(category);
      return group ? [{ category, rows: group }] : [];
    });
  }, [rows]);

  return (
    <section>
      <h3 className="text-lg font-semibold text-text-primary mb-3">
        Keyboard Shortcuts
      </h3>
      <div className="space-y-4">
        {grouped.map(({ category, rows: groupRows }) => (
          <div key={category}>
            <h4 className="text-sm font-medium text-text-tertiary mb-2">
              {CATEGORY_LABELS[category]}
            </h4>
            <div className="space-y-2">
              {groupRows.map((row) => (
                <div key={row.id} className="flex justify-between items-center gap-3">
                  <span className="text-text-secondary">
                    {row.label}
                    {row.availability === 'unavailable-platform' && (
                      <span className="ml-2 text-xs text-text-muted">unavailable on this platform</span>
                    )}
                  </span>
                  {row.effectiveChord ? (
                    <Kbd size="md">{formatKeyDisplay(row.effectiveChord)}</Kbd>
                  ) : (
                    <span className="text-xs text-text-muted italic">unassigned</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div>
          <h4 className="text-sm font-medium text-text-tertiary mb-2">Terminal / native — not remappable</h4>
          <div className="space-y-2">
            {REFERENCE_ROWS.map((reference) => (
              <div key={reference.id} className="flex justify-between items-center">
                <span className="text-text-secondary">{reference.label}</span>
                <Kbd size="md">{formatKeyDisplay(reference.chord)}</Kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

interface HelpProps {
  isOpen: boolean;
  onClose: () => void;
  shortcutsOnly?: boolean;
}

export default function Help({ isOpen, onClose, shortcutsOnly = false }: HelpProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" showCloseButton={false}>
      <ModalHeader title={shortcutsOnly ? 'Keyboard Shortcuts' : 'Pane Help'} />
      <ModalBody>
        {shortcutsOnly ? (
          <KeyboardShortcutsSection />
        ) : (
        <div className="space-y-8">
            {/* Quick Start */}
            <section>
              <h3 className="text-lg font-semibold text-text-primary mb-3 flex items-center">
                <Zap className="h-5 w-5 mr-2" />
                Quick Start
              </h3>
              <div className="space-y-3 text-text-secondary">
                <div className="bg-interactive/10 border border-interactive/30 rounded-lg p-3">
                  <p className="font-medium text-interactive mb-2">Prerequisites</p>
                  <ul className="list-disc list-inside space-y-1 text-sm">
                    <li>Claude Code must be installed with credentials configured</li>
                    <li>We recommend using a MAX plan for best performance</li>
                    <li>Pane runs Claude Code with <code className="bg-surface-tertiary px-1 rounded">--dangerously-ignore-permissions</code></li>
                  </ul>
                </div>
                
                <div>
                  <p className="font-medium mb-2">Getting Started:</p>
                  <ol className="list-decimal list-inside space-y-2">
                    <li><strong>Create or select a project:</strong>
                      <ul className="list-disc list-inside ml-4 mt-1 text-sm">
                        <li>Point to a new directory - Pane will create it and initialize git</li>
                        <li>Or select an existing git repository</li>
                      </ul>
                    </li>
                    <li><strong>Create panes:</strong>
                      <ul className="list-disc list-inside ml-4 mt-1 text-sm">
                        <li>Enter a prompt describing what you want Claude to do</li>
                        <li>Create multiple panes with different prompts to explore various approaches</li>
                        <li>Or run the same prompt multiple times to choose the best result</li>
                      </ul>
                    </li>
                    <li><strong>Work with results:</strong>
                      <ul className="list-disc list-inside ml-4 mt-1 text-sm">
                        <li>View changes in the Diff panel</li>
                        <li>Continue conversations to refine the solution</li>
                        <li>Rebase back to your main branch when done</li>
                      </ul>
                    </li>
                  </ol>
                </div>
              </div>
            </section>

            {/* Pane Management */}
            <section>
              <h3 className="text-lg font-semibold text-text-primary mb-3 flex items-center">
                <Terminal className="h-5 w-5 mr-2" />
                Pane Management
              </h3>
              <div className="space-y-3">
                <div>
                  <h4 className="font-medium text-text-primary">Creating Panes</h4>
                  <ul className="list-disc list-inside text-text-secondary mt-1 space-y-1">
                    <li>Enter a prompt describing what you want Claude to do</li>
                    <li>Optionally specify a worktree name template</li>
                    <li>Create multiple panes at once with the count field</li>
                    <li>Each pane gets its own git worktree branch</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-text-primary">Pane States</h4>
                  <ul className="list-disc list-inside text-text-secondary mt-1 space-y-1">
                    <li><span className="text-status-warning">Initializing</span> - Setting up git worktree</li>
                    <li><span className="text-interactive">Running</span> - Claude is processing</li>
                    <li><span className="text-status-success">Waiting</span> - Waiting for your input</li>
                    <li><span className="text-text-tertiary">Stopped</span> - Pane completed or stopped</li>
                    <li><span className="text-status-error">Error</span> - Something went wrong</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-text-primary">Continuing Conversations</h4>
                  <ul className="list-disc list-inside text-text-secondary mt-1 space-y-1">
                    <li>Click on a stopped pane to resume it</li>
                    <li>Use <Kbd size="md">{formatKeyDisplay('mod+enter')}</Kbd> to send input</li>
                    <li>Full conversation history is preserved</li>
                  </ul>
                </div>
              </div>
            </section>

            {/* Git Integration */}
            <section>
              <h3 className="text-lg font-semibold text-text-primary mb-3 flex items-center">
                <GitBranch className="h-5 w-5 mr-2" />
                Git Worktree Integration
              </h3>
              <div className="space-y-3">
                <p className="text-text-secondary">
                  Each pane operates in its own git worktree, allowing parallel development without conflicts.
                </p>
                <div>
                  <h4 className="font-medium text-text-primary">Git Operations</h4>
                  <ul className="list-disc list-inside text-text-secondary mt-1 space-y-1">
                    <li><strong>Rebase from main</strong> - Pull latest changes from main branch</li>
                    <li><strong>Squash and rebase to main</strong> - Combine commits and rebase onto main</li>
                    <li>View diffs in the View Diff tab</li>
                    <li>Track changes per execution</li>
                  </ul>
                </div>
              </div>
            </section>

            {/* View Tabs */}
            <section>
              <h3 className="text-lg font-semibold text-text-primary mb-3 flex items-center">
                <MessageSquare className="h-5 w-5 mr-2" />
                View Tabs
              </h3>
              <div className="space-y-2">
                <div>
                  <h4 className="font-medium text-text-primary">Output</h4>
                  <p className="text-text-secondary">Formatted terminal output with syntax highlighting</p>
                </div>
                <div>
                  <h4 className="font-medium text-text-primary">Messages</h4>
                  <p className="text-text-secondary">Raw JSON messages for debugging</p>
                </div>
                <div>
                  <h4 className="font-medium text-text-primary">View Diff</h4>
                  <p className="text-text-secondary">Git diffs showing all file changes</p>
                </div>
                <div>
                  <h4 className="font-medium text-text-primary">Terminal</h4>
                  <p className="text-text-secondary">Run project scripts (tests, builds, etc.)</p>
                </div>
              </div>
            </section>

            {/* Project Management */}
            <section>
              <h3 className="text-lg font-semibold text-text-primary mb-3 flex items-center">
                <Folder className="h-5 w-5 mr-2" />
                Project Management
              </h3>
              <div className="space-y-3">
                <div>
                  <h4 className="font-medium text-text-primary">Project Settings</h4>
                  <ul className="list-disc list-inside text-text-secondary mt-1 space-y-1">
                    <li>Custom system prompts per project</li>
                    <li>Run scripts for testing/building</li>
                    <li>Main branch configuration</li>
                    <li>Auto-creates directories and initializes git if needed</li>
                  </ul>
                </div>
              </div>
            </section>

            {/* Prompts Tab */}
            <section>
              <h3 className="text-lg font-semibold text-text-primary mb-3 flex items-center">
                <History className="h-5 w-5 mr-2" />
                Prompts History
              </h3>
              <div className="space-y-2 text-text-secondary">
                <p>Access all prompts from the Prompts tab in the sidebar:</p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  <li>Search through all prompts and pane names</li>
                  <li>Click "Use" to create a new pane with that prompt</li>
                  <li>Click "Copy" to copy prompt to clipboard</li>
                  <li>Navigate to specific prompts within panes</li>
                </ul>
              </div>
            </section>

            {/* Settings */}
            <section>
              <h3 className="text-lg font-semibold text-text-primary mb-3 flex items-center">
                <Settings className="h-5 w-5 mr-2" />
                Settings
              </h3>
              <div className="space-y-3">
                <div>
                  <h4 className="font-medium text-text-primary">Global Settings</h4>
                  <ul className="list-disc list-inside text-text-secondary mt-1 space-y-1">
                    <li>Verbose logging for debugging</li>
                    <li>Anthropic API key for AI features</li>
                    <li>Global system prompt additions</li>
                    <li>Custom Claude executable path</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-text-primary flex items-center">
                    <Bell className="h-4 w-4 mr-1" />
                    Notifications
                  </h4>
                  <ul className="list-disc list-inside text-text-secondary mt-1 space-y-1">
                    <li>Desktop notifications for status changes</li>
                    <li>Sound alerts when panes need input</li>
                    <li>Customizable notification triggers</li>
                  </ul>
                </div>
              </div>
            </section>

            {/* Keyboard Shortcuts */}
            <KeyboardShortcutsSection />

            {/* Tips */}
            <section>
              <h3 className="text-lg font-semibold text-text-primary mb-3">
                Tips & Tricks
              </h3>
              <ul className="list-disc list-inside text-text-secondary space-y-2">
                <li>Run multiple panes with different approaches to compare results</li>
                <li>Use descriptive worktree names to organize your experiments</li>
                <li>Check the View Diff tab to review what Claude modified</li>
                <li>Use the Terminal tab to run tests after Claude makes changes</li>
                <li>Archive panes you no longer need to keep your list clean</li>
                <li>Set up project-specific system prompts for consistent behavior</li>
                <li>Enable notifications to know when Claude needs your input</li>
              </ul>
            </section>
        </div>
        )}
      </ModalBody>
      
      <div className="p-4 border-t border-border-primary text-center text-sm text-text-muted">
        Pane - Manage multiple Claude Code instances with git worktrees
      </div>
    </Modal>
  );
}
