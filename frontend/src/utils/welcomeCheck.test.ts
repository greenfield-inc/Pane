import { describe, expect, it } from 'vitest';
import { welcomeCheckStep } from './welcomeCheck';

const ready = { checked: false, isLoaded: true, hasCheckedOnboarding: true, isOnboardingOpen: false, onOtherMachine: false };

describe('the Welcome check runs once, on this window\'s own first load (QA 1781 F-5)', () => {
  it('runs when this computer has loaded and onboarding is settled', () => {
    expect(welcomeCheckStep(ready)).toBe('run');
  });
  it('waits while loading or while onboarding is open', () => {
    expect(welcomeCheckStep({ ...ready, isLoaded: false })).toBe('wait');
    expect(welcomeCheckStep({ ...ready, hasCheckedOnboarding: false })).toBe('wait');
    expect(welcomeCheckStep({ ...ready, isOnboardingOpen: true })).toBe('wait');
  });
  it('never runs again once checked, so a host switch reloading the window shows nothing', () => {
    expect(welcomeCheckStep({ ...ready, checked: true })).toBe('skip');
    expect(welcomeCheckStep({ ...ready, checked: true, isLoaded: false })).toBe('skip');
  });
  it('never treats another machine as a first run', () => {
    expect(welcomeCheckStep({ ...ready, onOtherMachine: true })).toBe('skip');
  });
});
