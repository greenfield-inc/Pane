import { describe, expect, it } from 'vitest';
import { rememberedLaunchDefaults, settingsResume } from './sessionResume';

const DEFAULT_RESUME = { mode: 'reported' as const, initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' };
const SAVED_RESUME = { mode: 'reported' as const, initialTemplate: '{command}', resumeTemplate: '{command} --continue {sessionId}' };
const config = {
  defaultSessionCommand: 'my-agent --chat',
  defaultSessionResume: DEFAULT_RESUME,
  customCommands: [{ name: 'Saved agent', command: 'saved-agent', resume: SAVED_RESUME }, { name: 'No resume', command: 'plain-agent' }],
};

describe('settingsResume: Create New takes a custom command\'s resume from Settings only (T-63 build 8)', () => {
  it('gives none for the selected agent\'s own launch: Pane or Agent Farm resumes it', () => {
    expect(settingsResume(config, '')).toBeNull();
    expect(settingsResume(config, '   ')).toBeNull();
  });

  it('gives a saved custom command its own resume template', () => {
    expect(settingsResume(config, 'saved-agent')).toEqual(SAVED_RESUME);
    expect(settingsResume(config, 'plain-agent')).toBeNull();
  });

  it('gives the Session defaults command the Session defaults template', () => {
    expect(settingsResume(config, 'my-agent --chat')).toEqual(DEFAULT_RESUME);
  });

  it('gives a command Settings doesn\'t know no template', () => {
    expect(settingsResume(config, 'typed-agent --x')).toBeNull();
    expect(settingsResume(null, 'my-agent --chat')).toBeNull();
  });
});

describe('rememberedLaunchDefaults: a remembered command keeps its own template (#1762 F-1)', () => {
  it('saves a typed command with the template it started with, not the old command\'s', () => {
    const resume = settingsResume(config, 'typed-agent --x');
    const saved = rememberedLaunchDefaults(config, 'typed-agent --x', resume);
    expect(saved).toEqual({ defaultSessionCommand: 'typed-agent --x', defaultSessionResume: null });
    // The next Session from Create New resolves the saved pair: no template that launches my-agent.
    expect(settingsResume({ ...config, ...saved }, 'typed-agent --x')).toBeNull();
  });

  it('saves a saved custom command with its own template', () => {
    expect(rememberedLaunchDefaults(config, 'saved-agent', settingsResume(config, 'saved-agent')))
      .toEqual({ defaultSessionCommand: 'saved-agent', defaultSessionResume: SAVED_RESUME });
  });

  it('saves nothing when the command is already the default', () => {
    expect(rememberedLaunchDefaults(config, 'my-agent --chat', DEFAULT_RESUME)).toBeNull();
  });
});
