import { useEffect, useState } from 'react';
import { CLOUD_TOKEN_AGENTS, type CloudTokenAgent } from '../../../shared/types/paneCloudSecrets';
import { Button } from './ui/Button';
import { SecretValueInput } from './ui/SecretValueInput';

/**
 * Asked once, at the first cloud Session: an agent whose own sign-in renews itself (Claude Code)
 * would sign this computer out if it were copied, so cloud Sessions sign it in with a long-lived
 * token instead, saved here as a Pane secret and sent with the others.
 */
export function CloudSignInTokens() {
  const [missing, setMissing] = useState<readonly CloudTokenAgent[]>([]);

  useEffect(() => {
    let current = true;
    void window.electronAPI.paneCloud.secrets().then(
      (response) => {
        // Not knowing which are saved, ask for all: saving one again only replaces it.
        if (current) setMissing(response.success && response.data ? response.data.missingTokens : CLOUD_TOKEN_AGENTS);
      },
      () => { if (current) setMissing(CLOUD_TOKEN_AGENTS); },
    );
    return () => { current = false; };
  }, []);

  return <>{missing.map((agent) => (
    <TokenPrompt key={agent.id} agent={agent} onSaved={() => setMissing((list) => list.filter((entry) => entry.id !== agent.id))} />
  ))}</>;
}

function TokenPrompt({ agent, onSaved }: { agent: CloudTokenAgent; onSaved: () => void }) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!token.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await window.electronAPI.paneCloud.saveToken(agent.id, token);
      if (!response.success) {
        setError(response.error ?? 'Pane could not save the token.');
        return;
      }
      setToken('');
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Pane could not save the token.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="mt-2.5 block space-y-1.5 text-xs text-text-secondary" data-testid={`cloud-token-${agent.id}`}>
      <span className="block">
        {agent.title} signs in on cloud machines with a long-lived token. Run <code className="font-mono text-text-primary">{agent.command}</code> in a terminal on this computer, then paste the token here.
      </span>
      <span className="flex items-center gap-2">
        <SecretValueInput value={token} onValueChange={setToken} onEnter={() => void save()} aria-label={`${agent.title} token`} className="h-7 flex-1 text-xs" />
        <Button type="button" size="sm" variant="secondary" onClick={() => void save()} disabled={saving || !token.trim()}>Save</Button>
      </span>
      {error && <span className="block text-status-error">{error}</span>}
    </span>
  );
}
