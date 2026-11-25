import { useEffect, useRef, useState } from 'react';
import { CONFIGURED_AGENT_IDS, agentLabel } from '../../../../shared/agents';
import {
  MAX_WEB_LINK_LENGTH,
  buildStartLink,
  buildWebStartLink,
  normalizeLinkPrompt,
  startLinkButtonHtml,
  type StartLinkParts,
} from '../../../../shared/startLinks';
import { Button } from '../ui/Button';
import { Input, Textarea } from '../ui/Input';
import { LiveRegion } from '../ui/LiveRegion';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';

const ANY_AGENT = 'any';
type Where = 'new-session' | 'repo';

function CopyRow({ label, note, value, warning, onCopied }: { label: string; note: string; value: string; warning?: string; onCopied: (label: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      onCopied(label);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-label font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-tertiary">{note}</span>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded border border-border-primary bg-surface-secondary px-2 py-1.5 font-mono text-xs text-text-secondary" title={value}>{value}</code>
        {/* Copy and Copied share one fixed width, so the row doesn't shift. */}
        <Button type="button" size="sm" variant="secondary" className="w-20 shrink-0" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {warning && <p className="text-xs text-status-warning">{warning}</p>}
    </div>
  );
}

/** "Create Open in Pane link…": builds a start link, its web form and an HTML button from a prompt. */
export function StartLinkBuilderDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<string>(ANY_AGENT);
  const [where, setWhere] = useState<Where>('new-session');
  const [repo, setRepo] = useState('');
  const [announcement, setAnnouncement] = useState('');

  const checked = normalizeLinkPrompt(prompt);
  const repoMissing = where === 'repo' && !repo.trim();
  const problem = 'problem' in checked ? (prompt ? checked.problem : null) : repoMissing ? 'Name the repository as owner/repo or its saved name.' : null;
  const parts: StartLinkParts | null = 'prompt' in checked && !repoMissing
    ? { prompt: checked.prompt, agent: agent === ANY_AGENT ? undefined : agent, repo: where === 'repo' ? repo.trim() : undefined }
    : null;
  const webLink = parts ? buildWebStartLink(parts) : '';

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" showCloseButton={false}>
      <ModalHeader title="Create Open in Pane link" description="Put a button on a web page or in docs that starts an agent on your prompt in Pane." onClose={onClose} />
      <ModalBody className="space-y-4">
        <Textarea
          label="Prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          fullWidth
          autoFocus
          className="font-mono text-xs"
          error={problem ?? undefined}
        />
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="start-link-agent" className="text-label font-medium text-text-primary">Agent</label>
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger id="start-link-agent"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_AGENT}>Any installed agent</SelectItem>
                {CONFIGURED_AGENT_IDS.map((id) => <SelectItem key={id} value={id}>{agentLabel(id)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor="start-link-where" className="text-label font-medium text-text-primary">Runs in</label>
            <Select value={where} onValueChange={(next) => setWhere(next === 'repo' ? 'repo' : 'new-session')}>
              <SelectTrigger id="start-link-where"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="new-session">A new Session</SelectItem>
                <SelectItem value="repo">A repository</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {where === 'repo' && (
          <Input
            label="Repository"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="owner/repo, or a saved repository's name"
            fullWidth
            className="text-sm"
          />
        )}
        {parts ? (
          <div className="space-y-3 border-t border-border-primary pt-4">
            <CopyRow
              label="Web link"
              note="Recommended for web pages"
              value={webLink}
              warning={webLink.length > MAX_WEB_LINK_LENGTH ? 'Too long for a browser button: Chrome and Edge pass at most 2,048 characters.' : undefined}
              onCopied={(label) => setAnnouncement(`${label} copied`)}
            />
            <CopyRow label="Pane link" note="Opens Pane directly" value={buildStartLink(parts)} onCopied={(label) => setAnnouncement(`${label} copied`)} />
            <CopyRow
              label="HTML button"
              note="One line for a page"
              value={startLinkButtonHtml(parts, agent === ANY_AGENT ? undefined : agentLabel(agent))}
              onCopied={(label) => setAnnouncement(`${label} copied`)}
            />
          </div>
        ) : (
          !problem && <p className="text-sm text-text-tertiary">Write a prompt to get its links.</p>
        )}
        <LiveRegion>{announcement}</LiveRegion>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={onClose}>Done</Button>
      </ModalFooter>
    </Modal>
  );
}
