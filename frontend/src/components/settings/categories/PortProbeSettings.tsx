import { useId, useState } from 'react';
import { SaveState, SettingRow } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { cn } from '../../../utils/cn';
import { DEFAULT_PORT_PROBES_ENABLED, portRangesError } from '../../../../../shared/types/portProbes';

const PROBES_LABEL = 'Check which ports serve web pages';
const EXCLUDED_LABEL = 'Never check';

/**
 * The Ports list's HTTP probe (on by default) and the ports it never touches. Turning the probe
 * off disables the list but keeps it; ports are still listed either way.
 */
export function PortProbeSettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const enabled = config.portProbesEnabled ?? DEFAULT_PORT_PROBES_ENABLED;
  const savedExcluded = config.portProbeExcludedPorts ?? '';

  return (
    <SettingRow
      settingId="port-probes"
      label={PROBES_LABEL}
      description="The Ports list sends HEAD / to each listening port to tell web servers from other listeners. A listener that accepts one connection, such as an OAuth callback or a strict socket test, ends on that check: turn it off, or list its ports below. Unchecked ports are still listed, as tcp."
      saveState={persistence.saveStates['port-probes']}
      align="start"
      details={(
        <ExcludedPortsField
          key={savedExcluded}
          persistence={persistence}
          saved={savedExcluded}
          disabled={!enabled}
        />
      )}
    >
      <ImmediateToggle
        label={PROBES_LABEL}
        value={enabled}
        onSave={(value) => persistence.saveConfig('port-probes', { portProbesEnabled: value })}
      />
    </SettingRow>
  );
}

function ExcludedPortsField({ persistence, saved, disabled }: { persistence: SettingsPersistence; saved: string; disabled: boolean }) {
  const [text, setText] = useState(saved);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const error = portRangesError(text);

  const save = () => {
    if (error !== null || text.trim() === saved.trim()) return;
    void persistence.saveConfig('port-probe-excluded-ports', { portProbeExcludedPorts: text.trim() });
  };

  return (
    <div className={cn('space-y-1', disabled && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="text-sm text-text-primary">{EXCLUDED_LABEL}</label>
        <input
          id={inputId}
          type="text"
          spellCheck={false}
          placeholder="5173, 9000-9100"
          value={text}
          disabled={disabled}
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
          className={cn(
            'w-56 rounded-input border bg-bg-primary px-2 py-1 font-mono text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 disabled:cursor-not-allowed',
            error !== null ? 'border-status-error focus:ring-status-error' : 'border-border-primary focus:border-border-focus focus:ring-interactive',
          )}
        />
        <span className="text-sm text-text-secondary">ports and ranges</span>
        <SaveState state={persistence.saveStates['port-probe-excluded-ports'] ?? { state: 'idle' }} />
      </div>
      {error !== null && <p id={errorId} role="alert" className="text-xs text-status-error">{error}</p>}
    </div>
  );
}
