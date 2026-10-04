import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';
import { openSettingsAt } from '../../utils/settingsLinks';
import type { SettingsSettingId } from '../../types/settings';

interface SetupItem {
  missing: string;
  why: string;
  link: string;
  setting: SettingsSettingId;
}

const GITHUB_TOKEN: SetupItem = {
  missing: 'No GitHub token is set.',
  why: 'A new sandbox can\'t clone or push your private repositories.',
  link: 'Set a GitHub token',
  setting: 'remote-cloud-github-token',
};

const LOCAL_START_SCRIPT: SetupItem = {
  missing: 'No local start script is set.',
  why: 'Nothing from this computer, such as a Doppler token, reaches the sandbox.',
  link: 'Set a local start script',
  setting: 'remote-cloud-local-start-script',
};

/** The setup a new sandbox would miss, as links to each field. Never blocks adding one. */
export function CloudSandboxSetupWarning({ githubTokenSet, localStartScriptSet }: {
  githubTokenSet: boolean;
  localStartScriptSet: boolean;
}) {
  const items = [githubTokenSet ? null : GITHUB_TOKEN, localStartScriptSet ? null : LOCAL_START_SCRIPT]
    .filter((item): item is SetupItem => item !== null);
  if (items.length === 0) return null;

  return (
    <div
      role="status"
      aria-label="Setup a new sandbox would miss"
      className="mb-3 w-full space-y-2 rounded-md border border-status-warning/30 bg-status-warning/10 p-3 text-sm sm:w-[460px]"
    >
      {items.map((item) => (
        <div key={item.setting} className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-status-warning" aria-hidden="true" />
          <div className="min-w-0 space-y-1">
            <p className="text-text-primary">{item.missing} <span className="text-text-secondary">{item.why}</span></p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => openSettingsAt({ category: 'remote-access', setting: item.setting })}
            >
              {item.link}
            </Button>
          </div>
        </div>
      ))}
      <p className="text-xs text-text-tertiary">You can still add the sandbox now.</p>
    </div>
  );
}
