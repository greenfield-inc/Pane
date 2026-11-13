import { useEffect, useState } from 'react';
import { Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { CustomLink } from '../../../../../shared/types/customLinks';
import {
  customLinkPatternProblem,
  customLinkProblem,
  customLinkUrlProblem,
} from '../../../../../shared/utils/customLinks';
import { CUSTOM_LINK_MATCH_TIMEOUT_MS, matchCustomLinks, type CustomLinkMatchResult } from '../../../utils/customLinkMatcher';

/** How long Try it waits after the last keystroke before matching. */
const TRY_IT_DEBOUNCE_MS = 300;

interface LinksSettingsProps {
  persistence: SettingsPersistence;
  onDirtyChange: (dirty: boolean) => void;
}

export function LinksSettings({ persistence, onDirtyChange }: LinksSettingsProps) {
  const config = persistence.config!;
  const persistedLinks = config.customLinks ?? [];
  const persistedKey = JSON.stringify(persistedLinks);
  const [links, setLinks] = useState<CustomLink[]>(persistedLinks);
  const [sample, setSample] = useState('');
  const [tried, setTried] = useState<CustomLinkMatchResult | null>(null);
  const dirty = JSON.stringify(links) !== persistedKey;

  // SAFETY: App-owned storage writes this value through the matching typed serializer.
  useEffect(() => setLinks(JSON.parse(persistedKey) as CustomLink[]), [persistedKey]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const invalid = links.some((link) => !link.label.trim() || customLinkProblem(link) !== undefined);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void matchCustomLinks(sample, links).then((result) => {
        if (current) setTried(result);
      });
    }, TRY_IT_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [sample, links]);

  const update = (index: number, patch: Partial<CustomLink>) => {
    setLinks((current) => current.map((link, linkIndex) => (linkIndex === index ? { ...link, ...patch } : link)));
  };

  const apply = async () => {
    if (invalid) {
      return;
    }
    const trimmed = links.map((link) => ({ ...link, label: link.label.trim(), urlTemplate: link.urlTemplate.trim() }));
    const saved = await persistence.saveConfig('custom-links', { customLinks: trimmed });
    if (saved) {
      onDirtyChange(false);
    }
  };

  return (
    <SettingsPage title="Links" description="Turn text in terminal output into links that open in your browser.">
      <SettingsSection title="Terminal links">
        <SettingRow
          settingId="custom-links"
          label="Custom links"
          description={`Text matching a pattern (a regular expression) becomes a link. In the link, $0 is the whole match and $1 to $9 are its groups. Ctrl+Click (Cmd+Click on macOS) opens it. Where two patterns match the same text, the first one wins. A pattern that takes longer than ${CUSTOM_LINK_MATCH_TIMEOUT_MS} ms on a line, such as one with nested repeats like (a+)+, is stopped and that line gets no links.`}
          saveState={persistence.saveStates['custom-links']}
          align="start"
        >
          <div className="w-full space-y-3 sm:w-settings-control">
            {links.map((link, index) => (
              <div key={link.id} className="space-y-2 rounded-md border border-border-secondary p-3">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                  <Input
                    label="Name"
                    value={link.label}
                    placeholder="Jira"
                    onChange={(event) => update(index, { label: event.target.value })}
                    error={!link.label.trim() ? 'Name is required' : undefined}
                    fullWidth
                  />
                  <div className="flex gap-1 pt-6">
                    <IconButton
                      type="button"
                      aria-label={link.enabled ? 'Disable link' : 'Enable link'}
                      title={link.enabled ? 'Disable' : 'Enable'}
                      icon={link.enabled ? <Power className="h-4 w-4 text-status-success" /> : <PowerOff className="h-4 w-4" />}
                      onClick={() => update(index, { enabled: !link.enabled })}
                    />
                    <IconButton
                      type="button"
                      aria-label="Delete link"
                      title="Delete"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setLinks((current) => current.filter((_, linkIndex) => linkIndex !== index))}
                    />
                  </div>
                </div>
                <Input
                  label="Pattern"
                  value={link.pattern}
                  placeholder="\b(?:PROJ|OPS)-\d+\b"
                  onChange={(event) => update(index, { pattern: event.target.value })}
                  error={customLinkPatternProblem(link.pattern)}
                  className="font-mono text-sm"
                  spellCheck={false}
                  fullWidth
                />
                <Input
                  label="Link"
                  value={link.urlTemplate}
                  placeholder="https://example.atlassian.net/browse/$0"
                  onChange={(event) => update(index, { urlTemplate: event.target.value })}
                  error={customLinkUrlProblem(link.urlTemplate)}
                  className="font-mono text-sm"
                  spellCheck={false}
                  fullWidth
                />
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setLinks((current) => [...current, {
                  enabled: true, id: crypto.randomUUID(), label: '', pattern: '', urlTemplate: '',
                }])}
              >
                Add Link
              </Button>
              <Button type="button" size="sm" disabled={!dirty || invalid} onClick={apply}>Apply</Button>
            </div>
            {links.length > 0 && (
              <div className="space-y-2">
                <Input
                  label="Try it"
                  value={sample}
                  placeholder="Paste some terminal output"
                  onChange={(event) => setSample(event.target.value)}
                  spellCheck={false}
                  fullWidth
                />
                {sample && tried && (
                  <ul className="space-y-1 text-xs text-text-secondary" aria-label="Links found">
                    {tried.timedOut && <li className="text-status-warning">Matching this text took longer than {CUSTOM_LINK_MATCH_TIMEOUT_MS} ms, so Pane stopped it. A terminal line like this gets no links.</li>}
                    {!tried.timedOut && tried.matches.length === 0 && <li>No links in this text.</li>}
                    {tried.matches.map((match) => (
                      <li key={match.start} className="break-all font-mono">
                        <span className="text-text-primary">{match.text}</span> → {match.url}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
