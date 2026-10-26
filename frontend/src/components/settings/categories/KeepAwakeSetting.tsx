import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { SaveState, SettingRow } from '../SettingRow';
import { ImmediateCheckbox, ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { cn } from '../../../utils/cn';
import { isMac, isWindows } from '../../../utils/platformUtils';

const MASTER_LABEL = 'Keep awake while sessions are active';

/**
 * The keep-awake master toggle and, under its chevron, when it applies: plugged
 * in and on battery, both off by default (on battery it also keeps the screen
 * on). Turning the toggle off disables both boxes but keeps their values.
 */
export function KeepAwakeSetting({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const enabled = config.keepAwakeWhileSessionsActive !== false;
  const [expanded, setExpanded] = useState(true);
  const optionsId = useId();

  return (
    <SettingRow
      settingId="keep-awake"
      label={MASTER_LABEL}
      description="Stops idle sleep while an agent is running or waiting."
      saveState={persistence.saveStates['keep-awake']}
      align="start"
      leading={(
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={optionsId}
          aria-label="Keep-awake options"
          title={expanded ? 'Hide options' : 'Show options'}
          onClick={() => setExpanded(!expanded)}
          className="-ml-1 rounded p-0.5 text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')} />
        </button>
      )}
      details={(
        <div id={optionsId} hidden={!expanded} className={cn('ml-6 space-y-3', !enabled && 'opacity-60')}>
          <div>
            <ImmediateCheckbox
              label="While plugged in"
              description="The screen may turn off. The computer keeps working."
              value={config.keepAwakeWhilePluggedIn !== false}
              disabled={!enabled}
              onSave={(value) => persistence.saveConfig('keep-awake-plugged-in', { keepAwakeWhilePluggedIn: value })}
            />
            <div className="ml-6"><SaveState state={persistence.saveStates['keep-awake-plugged-in'] ?? { state: 'idle' }} /></div>
          </div>
          <div>
            <ImmediateCheckbox
              label="While on battery"
              description={isWindows()
                ? 'Keeps the screen on and stops auto-lock. Uses more battery.'
                : 'Keeps the screen on. Uses more battery.'}
              value={config.keepAwakeOnBattery === true}
              disabled={!enabled}
              onSave={(value) => persistence.saveConfig('keep-awake-on-battery', { keepAwakeOnBattery: value })}
            />
            <div className="ml-6"><SaveState state={persistence.saveStates['keep-awake-on-battery'] ?? { state: 'idle' }} /></div>
          </div>
          <p className="max-w-2xl border-l-2 border-border-primary pl-2.5 text-xs leading-relaxed text-text-tertiary">
            <LidHint />
          </p>
        </div>
      )}
    >
      <ImmediateToggle
        label={MASTER_LABEL}
        value={enabled}
        onSave={(value) => persistence.saveConfig('keep-awake', { keepAwakeWhileSessionsActive: value })}
      />
    </SettingRow>
  );
}

/** Pane does not change what closing the lid does, so it says how to, for this OS only. */
function LidHint() {
  if (isWindows()) {
    return (
      <>
        Closing the lid still puts your PC to sleep. To keep working with it closed, go
        to <i>Control Panel → Power Options → Choose what closing the lid does</i> and
        set <b>Plugged in</b> to <b>Do nothing</b>.
      </>
    );
  }
  if (isMac()) {
    return (
      <>
        Closing the lid still puts your Mac to sleep, unless it&apos;s plugged in and connected to an external
        display, keyboard and mouse (clamshell mode).
      </>
    );
  }
  return (
    <>
      Closing the lid still suspends most systems. To change it,
      set <code>HandleLidSwitchExternalPower=ignore</code> in <code>/etc/systemd/logind.conf</code>, or use your
      desktop&apos;s power settings.
    </>
  );
}
