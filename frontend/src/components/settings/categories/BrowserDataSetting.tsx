import { useState } from 'react';
import { AlertCircle, Check, Trash2 } from 'lucide-react';
import { SettingRow } from '../SettingRow';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ConfirmDialog';
import { clearBrowserData, type ClearBrowserDataOutcome } from '../clearBrowserData';

export function BrowserDataSetting() {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [outcome, setOutcome] = useState<ClearBrowserDataOutcome | null>(null);

  const clear = async () => {
    setClearing(true);
    setOutcome(null);
    setOutcome(await clearBrowserData());
    setClearing(false);
  };

  return (
    <SettingRow
      settingId="browser-data"
      label="Browser data"
      description="Pane's browser keeps one set of logins, cookies and site data for every project and Session."
    >
      <div className="flex flex-col gap-1.5 sm:items-end">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Trash2 className="h-4 w-4" />}
          loading={clearing}
          loadingText="Clearing"
          onClick={() => setConfirming(true)}
        >
          Clear browser data
        </Button>
        {outcome?.kind === 'success' && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success" aria-live="polite">
            <Check className="h-3 w-3 flex-none" /> {outcome.message}
          </span>
        )}
        {outcome?.kind === 'failure' && (
          <span className="flex max-w-sm items-start gap-1 text-xs text-status-error" role="alert">
            <AlertCircle className="mt-0.5 h-3 w-3 flex-none" /> {outcome.message}
          </span>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void clear()}
        title="Clear browser data?"
        message="This signs you out of every site in Pane's browser, including GitHub and Grain, and removes their cookies, site data and cache. Open browser tabs will reload. This can't be undone."
        confirmText="Clear browser data"
        variant="danger"
      />
    </SettingRow>
  );
}
