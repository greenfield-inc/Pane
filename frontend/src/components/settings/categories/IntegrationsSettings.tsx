import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { SecretField } from '../SecretField';
import { SegmentedControl } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { AppConfig } from '../../../types/config';
import type { VoiceTranscriptionMode } from '../../../../../shared/types/voiceTranscription';
import type { ApnsCredentialConfig, SharedCredentialId } from '../../../../../shared/types/sharedCredentials';
import { formatDistanceToNow } from '../../../utils/timestampUtils';
import { VOICE_KEY_FIELDS, voiceKeyProblem, type VoiceKeyCheck, type VoiceKeyField } from '../../../../../shared/voice/voiceKeys';

const SHARING_DOCS_URL = 'https://github.com/greenfield-inc/Pane/blob/main/docs/SHARED_CREDENTIALS.md';
const DEFAULT_APNS_TOPIC = 'com.dcouple.pane.mobile';

interface IntegrationsSettingsProps {
  persistence: SettingsPersistence;
  onDirtyChange: (dirty: boolean) => void;
}

/** Where a saved key came from, e.g. "Set on Parsas-MacBook-Pro 2 days ago". */
function keySource(config: AppConfig, id: SharedCredentialId, configured: boolean): string | undefined {
  const meta = config.sharedCredentials?.[id];
  if (!meta || !configured || Date.parse(meta.updatedAt) <= 0) return undefined;
  return `Set on ${meta.source} ${formatDistanceToNow(meta.updatedAt)}`;
}

function SharingNote() {
  return (
    <p className="text-xs text-text-tertiary">
      Pane shares these keys with your other Pane hosts through the devices you paired, so you set each one once.{' '}
      <button type="button" className="text-interactive hover:underline" onClick={() => void window.electronAPI.openExternal(SHARING_DOCS_URL)}>
        How sharing works
      </button>
    </p>
  );
}

export function IntegrationsSettings({ persistence, onDirtyChange }: IntegrationsSettingsProps) {
  const config = persistence.config!;
  const persisted = {
    falApiKey: config.falApiKey ?? '',
    openRouterApiKey: config.openRouterApiKey ?? '',
    deepgramApiKey: config.deepgramApiKey ?? '',
    // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
    voiceTranscriptionMode: config.voiceTranscriptionMode ?? 'streaming' as VoiceTranscriptionMode,
  };
  const persistedKey = JSON.stringify(persisted);
  const [draft, setDraft] = useState(persisted);
  /** Per key: why it can't be saved, or what Deepgram said about the saved one. Cleared when the key is edited. */
  const [keyNotes, setKeyNotes] = useState<Partial<Record<VoiceKeyField, VoiceKeyCheck | { result: 'checking'; message: string }>>>({});
  const persistedApnsKey = JSON.stringify(config.apns ?? EMPTY_APNS);
  const [apnsDraft, setApnsDraft] = useState<ApnsCredentialConfig>(config.apns ?? EMPTY_APNS);
  const apnsDirty = JSON.stringify(apnsDraft) !== persistedApnsKey;
  const dirty = JSON.stringify(draft) !== persistedKey;

  // SAFETY: App-owned storage writes this value through the matching typed serializer.
  useEffect(() => setDraft(JSON.parse(persistedKey) as typeof persisted), [persistedKey]);
  // SAFETY: persistedApnsKey is serialized from the same ApnsCredentialConfig shape.
  useEffect(() => setApnsDraft(JSON.parse(persistedApnsKey) as ApnsCredentialConfig), [persistedApnsKey]);
  useEffect(() => onDirtyChange(dirty || apnsDirty), [dirty, apnsDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const apply = async () => {
    const problems: typeof keyNotes = {};
    for (const field of VOICE_KEY_FIELDS) {
      const problem = draft[field].trim() ? voiceKeyProblem(field, draft[field].trim()) : null;
      if (problem) problems[field] = { result: 'rejected', message: `${problem.message} ${problem.next}` };
    }
    setKeyNotes(problems);
    if (Object.keys(problems).length > 0) {
      persistence.reportSaveError('voice-transcription', 'Nothing was saved: fix the key marked below.');
      return;
    }
    const deepgramApiKey = draft.deepgramApiKey.trim();
    const saved = await persistence.saveConfig('voice-transcription', {
      falApiKey: draft.falApiKey.trim() || undefined,
      openRouterApiKey: draft.openRouterApiKey.trim() || undefined,
      deepgramApiKey: deepgramApiKey || undefined,
      voiceTranscriptionMode: draft.voiceTranscriptionMode,
    });
    if (saved && !apnsDirty) onDirtyChange(false);
    if (!saved || !deepgramApiKey || deepgramApiKey === persisted.deepgramApiKey) return;
    setKeyNotes({ deepgramApiKey: { result: 'checking', message: 'Saved. Checking the key with Deepgram…' } });
    const check = await window.electronAPI.config.checkDeepgramKey(deepgramApiKey)
      .catch((error: Error): VoiceKeyCheck => ({ result: 'unchecked', message: `Saved, but Pane couldn't check the key: ${error.message}` }));
    setKeyNotes({ deepgramApiKey: check });
  };

  const editKey = (field: VoiceKeyField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setKeyNotes((current) => ({ ...current, [field]: undefined }));
  };
  const keyError = (field: VoiceKeyField) => (keyNotes[field]?.result === 'rejected' ? keyNotes[field]?.message : undefined);
  const keyHelper = (field: VoiceKeyField) => (keyNotes[field] && keyNotes[field]?.result !== 'rejected' ? keyNotes[field]?.message : source(field));

  // Only a saved key has a source; an edit in progress doesn't.
  const source = (id: 'falApiKey' | 'openRouterApiKey' | 'deepgramApiKey') => keySource(config, id, draft[id].length > 0 && draft[id] === persisted[id]);

  return (
    <SettingsPage title="Integrations" description="Provider credentials used by Pane's voice dictation and iPhone notifications.">
      <SettingsSection title="Voice transcription" description="Credentials stay in Pane's application config and are masked by default.">
        <SettingRow
          settingId="voice-transcription"
          label="Provider credentials"
          description="Deepgram transcribes live dictation and fal transcribes recorded audio; either one is enough. OpenRouter is optional and cleans up the transcript."
          saveState={persistence.saveStates['voice-transcription']}
          align="start"
        >
          <div className="w-full space-y-3 sm:w-[460px]">
            <SharingNote />
            <SecretField
              label="Fal API key"
              value={draft.falApiKey}
              placeholder="fal_..."
              helperText={keyHelper('falApiKey')}
              error={keyError('falApiKey')}
              onChange={(value) => editKey('falApiKey', value)}
              onRemove={() => editKey('falApiKey', '')}
            />
            <SecretField
              label="OpenRouter API key (optional)"
              value={draft.openRouterApiKey}
              placeholder="sk-or-..."
              helperText={keyHelper('openRouterApiKey')}
              error={keyError('openRouterApiKey')}
              onChange={(value) => editKey('openRouterApiKey', value)}
              onRemove={() => editKey('openRouterApiKey', '')}
            />
            <SecretField
              label="Deepgram API key"
              value={draft.deepgramApiKey}
              placeholder="dg_..."
              helperText={keyHelper('deepgramApiKey')}
              error={keyError('deepgramApiKey')}
              onChange={(value) => editKey('deepgramApiKey', value)}
              onRemove={() => editKey('deepgramApiKey', '')}
            />
            <div className="space-y-2">
              <p className="text-xs font-medium text-text-secondary">Default PWA voice mode</p>
              <SegmentedControl<VoiceTranscriptionMode>
                label="Default PWA voice mode"
                value={draft.voiceTranscriptionMode}
                options={[
                  { id: 'streaming', label: 'Live streaming', description: 'Deepgram Nova-3 with realtime text.' },
                  { id: 'recorded', label: 'Batch recorded', description: 'Fal Wizper after recording stops.' },
                ]}
                onChange={(value) => setDraft((current) => ({ ...current, voiceTranscriptionMode: value }))}
              />
            </div>
            <div className="flex justify-end">
              <Button type="button" size="sm" disabled={!dirty} onClick={apply}>Apply Voice Settings</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
      <ApnsSettings persistence={persistence} draft={apnsDraft} setDraft={setApnsDraft} dirty={apnsDirty} />
    </SettingsPage>
  );
}

const EMPTY_APNS: ApnsCredentialConfig = { teamId: '', keyId: '', privateKey: '', topic: DEFAULT_APNS_TOPIC, environment: 'production' };

interface ApnsSettingsProps {
  persistence: SettingsPersistence;
  draft: ApnsCredentialConfig;
  setDraft: Dispatch<SetStateAction<ApnsCredentialConfig>>;
  dirty: boolean;
}

function ApnsSettings({ persistence, draft, setDraft, dirty }: ApnsSettingsProps) {
  const config = persistence.config!;
  const [pickError, setPickError] = useState<string | null>(null);
  const complete = [draft.teamId, draft.keyId, draft.privateKey, draft.topic].every(value => value.trim().length > 0);
  const cleared = draft.privateKey.length === 0 && config.apns !== undefined;

  const chooseKey = async () => {
    setPickError(null);
    const response = await window.electronAPI.config.chooseApnsKey();
    if (!response.success) {
      setPickError(response.error ?? 'Could not read that key file.');
      return;
    }
    const picked = response.data;
    if (picked) setDraft(current => ({ ...current, privateKey: picked.privateKey, keyId: picked.keyId ?? current.keyId }));
  };

  const apply = async () => {
    const apns = cleared ? undefined : {
      teamId: draft.teamId.trim(), keyId: draft.keyId.trim(), privateKey: draft.privateKey, topic: draft.topic.trim(), environment: draft.environment,
    };
    await persistence.saveConfig('apns-credentials', { apns });
  };

  return (
    <SettingsSection
      title="iPhone notifications"
      description="Apple push credentials this host uses to notify the Pane iPhone app. Environment variables on a host override them."
    >
      <SettingRow
        settingId="apns-credentials"
        label="APNs key"
        description="The .p8 key from your Apple Developer account, with its team ID. Shared with your other hosts like the keys above."
        saveState={persistence.saveStates['apns-credentials']}
        align="start"
      >
        <div className="w-full space-y-3 sm:w-[460px]">
          <SecretField
            label="APNs key (.p8)"
            value={draft.privateKey}
            placeholder="Choose the key file below"
            helperText={pickError ?? keySource(config, 'apns', draft.privateKey.length > 0 && draft.privateKey === config.apns?.privateKey)}
            readOnly
          />
          <div className="flex justify-end gap-2">
            {draft.privateKey && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(current => ({ ...current, privateKey: '' }))}>Remove key</Button>
            )}
            <Button type="button" size="sm" variant="secondary" onClick={() => void chooseKey()}>Choose key file…</Button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Team ID" fullWidth value={draft.teamId} placeholder="ABCDE12345" onChange={event => setDraft(current => ({ ...current, teamId: event.target.value }))} />
            <Input label="Key ID" fullWidth value={draft.keyId} placeholder="From the file name" onChange={event => setDraft(current => ({ ...current, keyId: event.target.value }))} />
          </div>
          <Input label="App bundle ID" fullWidth value={draft.topic} onChange={event => setDraft(current => ({ ...current, topic: event.target.value }))} />
          <SegmentedControl<ApnsCredentialConfig['environment']>
            label="APNs environment"
            value={draft.environment}
            options={[
              { id: 'production', label: 'Production', description: 'TestFlight and App Store builds.' },
              { id: 'sandbox', label: 'Sandbox', description: 'Development builds from Xcode or Expo.' },
            ]}
            onChange={value => setDraft(current => ({ ...current, environment: value }))}
          />
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={!dirty || !(complete || cleared)} onClick={() => void apply()}>Apply Notification Settings</Button>
          </div>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
