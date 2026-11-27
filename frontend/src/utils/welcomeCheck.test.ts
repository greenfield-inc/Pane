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

describe('QA M-282: welcome seen, no projects, "Don\'t show this again" unticked', () => {
  it('shows once on the window\'s first load, and never on the 12 switches to B and back that follow', () => {
    // That machine's state: Welcome closed with X before, so it shows again whenever the check runs.
    const showsWhenRun = true;
    let checked = false;
    let shown = 0;
    const load = (onOtherMachine: boolean) => {
      const step = welcomeCheckStep({ checked, isLoaded: true, hasCheckedOnboarding: true, isOnboardingOpen: false, onOtherMachine });
      if (step === 'wait') return;
      checked = true;
      if (step === 'run' && showsWhenRun) shown += 1;
    };
    load(false);
    for (let flip = 0; flip < 6; flip++) {
      // isLoaded goes false while the switch restores, then true on B, and the same back on A.
      expect(welcomeCheckStep({ checked, isLoaded: false, hasCheckedOnboarding: true, isOnboardingOpen: false, onOtherMachine: true })).toBe('skip');
      load(true);
      load(false);
    }
    expect(shown).toBe(1);
  });
});
