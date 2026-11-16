import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, Minus } from 'lucide-react';
import type { DeviceSettings, DeviceSettingsView } from '../../../../../shared/types/devices';
import { Toggle } from '../../ui/Toggle';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { settingDomId } from '../catalog';
import { cn } from '../../../utils/cn';

const DOCS_URL = 'https://runpane.com/docs/devices';

/**
 * Settings > Devices: the agent device tools switch, which Mac runs iOS on a machine without
 * Xcode (radio rows, option 2 of the D-71 mockups), how many simulators boot at once, and what
 * this machine has installed.
 */
export function DevicesSettings() {
  const [view, setView] = useState<DeviceSettingsView>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const response = await window.electronAPI.devices.settings();
    if (response.success && response.data) setView(response.data);
    else setError(response.error ?? 'Pane could not read its device settings.');
  }, []);

  useEffect(() => { void load(); }, [load]);

  const update = async (patch: { enabled?: boolean; iosMachineId?: string | null; maxBooted?: number }) => {
    const response = await window.electronAPI.devices.updateSettings(patch);
    if (response.success && response.data) {
      const settings: DeviceSettings = response.data;
      setView(current => current && { ...current, settings });
    } else {
      setError(response.error ?? 'Pane could not save that.');
    }
  };

  return (
    <SettingsPage title="Devices" description="Phone simulators and emulators that agents open in a device tab.">
      {error && <p className="text-sm text-status-error" role="alert">{error}</p>}
      {view && (
        <>
          <SettingsSection title="Agents">
            <SettingRow settingId="devices-enabled" label="Agent device tools" description="device_open, device_act and the other device tools in every agent's Pane tools and in runpane devices.">
              <Toggle checked={view.settings.enabled} onChange={(enabled) => { void update({ enabled }); }} />
            </SettingRow>
            <SettingRow settingId="devices-max-booted" label="Simulators at once" description="Booted devices per platform on this machine. Panes share them; raise it when memory allows each Pane its own.">
              <div className="inline-flex overflow-hidden rounded border border-border-primary" role="radiogroup" aria-label="Simulators at once">
                {[1, 2, 3, 4].map(count => (
                  <button
                    key={count}
                    type="button"
                    role="radio"
                    aria-checked={view.settings.maxBooted === count}
                    onClick={() => { void update({ maxBooted: count }); }}
                    className={cn('h-7 w-9 text-sm', view.settings.maxBooted === count ? 'bg-interactive text-text-on-interactive' : 'bg-surface-primary text-text-secondary hover:bg-surface-hover')}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </SettingRow>
          </SettingsSection>

          <SettingsSection title="iOS devices run on">
            <div id={settingDomId('devices-ios-machine')} data-setting-id="devices-ios-machine" tabIndex={-1} className="outline-none">
              {view.capabilities.ios.ready ? (
                <p className="text-sm text-text-secondary">This Mac has Xcode, so iOS simulators run here.</p>
              ) : (
                <IosMachinePicker view={view} onPick={(iosMachineId) => { void update({ iosMachineId }); }} />
              )}
            </div>
          </SettingsSection>

          <SettingsSection title="On this machine">
            <div className="divide-y divide-border-primary rounded border border-border-primary">
              <StatusRow ok={view.helpersInstalled} label="Device tools (agent-device, Expo device hub)" detail={view.helpersInstalled ? 'Installed' : 'Installed on first use'} />
              <StatusRow ok={view.capabilities.ios.ready} label="Xcode with an iOS runtime" detail={view.capabilities.ios.ready ? 'Ready' : view.capabilities.ios.reason} />
              <StatusRow ok={view.capabilities.android.ready} label="Android SDK and emulator" detail={view.capabilities.android.ready ? 'Ready' : view.capabilities.android.reason} />
              <StatusRow ok={view.capabilities.simslim} label="SimSlim (smaller iOS simulators)" detail={view.capabilities.simslim ? 'Installed: Pane slims its simulators' : 'Optional: brew install mobai-app/tap/simslim'} />
              <StatusRow ok={view.capabilities.npm} label="npm" detail={view.capabilities.npm ? 'Found' : 'Needed once to install the device tools: install Node.js'} />
            </div>
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm text-interactive hover:text-interactive-hover">
              How devices work <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
}

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">{ok ? <Check className="h-4 w-4 text-status-success" /> : <Minus className="h-4 w-4 text-text-tertiary" />}</span>
      <div className="min-w-0">
        <p className="text-sm text-text-primary">{label}</p>
        <p className="text-xs text-text-tertiary">{detail}</p>
      </div>
    </div>
  );
}

/** Automatic, then each saved Mac with whether it is online. A pinned Mac is always used. */
function IosMachinePicker({ view, onPick }: { view: DeviceSettingsView; onPick: (id: string | null) => void }) {
  const pinned = view.settings.iosMachineId;
  const automatic = view.macs.find(mac => mac.online);
  return (
    <>
      <div className="divide-y divide-border-primary overflow-hidden rounded border border-border-primary" role="radiogroup" aria-label="iOS devices run on">
        <RadioRow checked={!pinned} onSelect={() => onPick(null)} label="Automatic" detail={`The first online Mac with Xcode. Now: ${automatic?.name ?? 'none online'}`} />
        {view.macs.map(mac => (
          <RadioRow key={mac.id} checked={pinned === mac.id} onSelect={() => onPick(mac.id)} label={mac.name} online={mac.online} />
        ))}
      </div>
      <p className="mt-2 text-xs text-text-tertiary">
        {view.macs.length === 0
          ? 'This computer has no Xcode and no linked Mac. Link one in Add a device > Computer. Android emulators run on this computer.'
          : 'This computer has no Xcode, so iOS simulators run on a linked Mac. Android emulators run on this computer.'}
      </p>
    </>
  );
}

function RadioRow({ checked, onSelect, label, detail, online }: { checked: boolean; onSelect: () => void; label: string; detail?: string; online?: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={checked} onClick={onSelect} className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left', checked ? 'bg-surface-secondary' : 'hover:bg-surface-hover')}>
      <span className={cn('flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border', checked ? 'border-interactive' : 'border-border-secondary')}>
        {checked && <span className="h-2 w-2 rounded-full bg-interactive" />}
      </span>
      {online !== undefined && <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', online ? 'bg-status-success' : 'bg-status-neutral')} />}
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-text-primary">{label}</span>
        {detail && <span className="block text-xs text-text-tertiary">{detail}</span>}
      </span>
      {online !== undefined && <span className="text-xs text-text-tertiary">{online ? 'Online' : 'Offline'}</span>}
    </button>
  );
}
