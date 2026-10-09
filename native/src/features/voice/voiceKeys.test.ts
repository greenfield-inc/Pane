import { describe, expect, it } from 'vitest';

import type { RemotePwaVoiceTranscriptionAffordance } from '@shared/types/remoteDaemon';

import { canStartVoice, hostNeedsUpdate, maskSecrets, micMode, voiceKeysFor } from './voiceKeys';

const presentation = { label: '', priceLabel: '', latencyLabel: '', recommended: false };

/** The affordance a host reports for the keys it has. `legacy` is a host before v2.4.159, which needed OpenRouter for each mode. */
function host(keys: { deepgram?: boolean; fal?: boolean; openRouter?: boolean }, legacy = false): RemotePwaVoiceTranscriptionAffordance {
  const { deepgram = false, fal = false, openRouter = false } = keys;
  const streaming = deepgram && (openRouter || !legacy);
  const recorded = fal && (openRouter || !legacy);
  const availableModes = [...(streaming ? ['streaming' as const] : []), ...(recorded ? ['recorded' as const] : [])];
  return {
    availableModes,
    defaultMode: availableModes[0] ?? 'streaming',
    configured: { cleanup: openRouter, recorded, streaming, fal, deepgram, openRouter },
    modes: { streaming: presentation, recorded: presentation },
  };
}

describe('micMode', () => {
  it('records live with only a Deepgram key, on a current host', () => {
    expect(micMode(host({ deepgram: true }))).toBe('streaming');
  });

  it('records with fal when that is the only key', () => {
    expect(micMode(host({ fal: true }))).toBe('recorded');
  });

  it('opens setup when the host has no transcription key', () => {
    expect(micMode(host({ openRouter: true }))).toBeNull();
  });

  it('opens setup on a host before v2.4.159 that has Deepgram but no OpenRouter', () => {
    expect(micMode(host({ deepgram: true }, true))).toBeNull();
  });
});

describe('voiceKeysFor', () => {
  it('asks live mode for Deepgram and recorded mode for fal, with OpenRouter cleanup optional in both', () => {
    expect(voiceKeysFor('streaming', host({}))).toEqual([
      { key: 'deepgramApiKey', set: false, optional: false },
      { key: 'openRouterApiKey', set: false, optional: true },
    ]);
    expect(voiceKeysFor('recorded', host({ openRouter: true }))).toEqual([
      { key: 'falApiKey', set: false, optional: false },
      { key: 'openRouterApiKey', set: true, optional: true },
    ]);
  });

  it('requires OpenRouter on a host before v2.4.159 that has the mode key', () => {
    expect(voiceKeysFor('streaming', host({ deepgram: true }, true))).toEqual([
      { key: 'deepgramApiKey', set: true, optional: false },
      { key: 'openRouterApiKey', set: false, optional: false },
    ]);
  });
});

describe('hostNeedsUpdate', () => {
  it('is true only when the host has the mode key and still cannot run the mode', () => {
    expect(hostNeedsUpdate('streaming', host({ deepgram: true }, true))).toBe(true);
    expect(hostNeedsUpdate('streaming', host({ deepgram: true }))).toBe(false);
    expect(hostNeedsUpdate('streaming', host({}, true))).toBe(false);
  });
});

describe('canStartVoice', () => {
  it('starts with the keys the host already has, without typing anything', () => {
    expect(canStartVoice('streaming', host({ deepgram: true }), {})).toBe(true);
  });

  it('waits for the missing mode key, and starts once it is typed', () => {
    expect(canStartVoice('streaming', host({}), {})).toBe(false);
    expect(canStartVoice('streaming', host({}), { openRouterApiKey: 'or-1' })).toBe(false);
    expect(canStartVoice('streaming', host({}), { deepgramApiKey: '  ' })).toBe(false);
    expect(canStartVoice('streaming', host({}), { deepgramApiKey: 'dg-1' })).toBe(true);
  });

  it('on a host before v2.4.159, starts once OpenRouter is typed', () => {
    expect(canStartVoice('streaming', host({ deepgram: true }, true), {})).toBe(false);
    expect(canStartVoice('streaming', host({ deepgram: true }, true), { openRouterApiKey: 'or-1' })).toBe(true);
  });
});

describe('maskSecrets', () => {
  it('hides every typed key in an error message', () => {
    expect(maskSecrets('Deepgram rejected dg-abc123 (and dg-abc123)', ['dg-abc123', ''])).toBe('Deepgram rejected ••• (and •••)');
  });
});
