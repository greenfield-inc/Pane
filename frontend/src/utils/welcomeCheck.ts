/** What the window's Welcome check does now: run it, wait for loading or onboarding, or skip it for good. */
export type WelcomeCheckStep = 'run' | 'wait' | 'skip';

/**
 * The Welcome check runs once, on this window's own first load (QA 1781 F-5). A host switch reloads
 * the window's data, and the machine it shows has its own preferences, projects and Sessions: read
 * then, a machine with projects whose window never showed Welcome looked like a first run, and the
 * dialog opened over everything. So it never runs again once checked, and never for another machine.
 */
/** Which machine the window shows, as far as it knows yet. */
export type WindowMachine = 'loading' | 'this' | 'other' | 'unreadable';

export function welcomeCheckStep(state: { checked: boolean; isLoaded: boolean; hasCheckedOnboarding: boolean; isOnboardingOpen: boolean; machine: WindowMachine }): WelcomeCheckStep {
  if (state.checked) return 'skip';
  // A window that starts on another machine decides only once it knows which one it shows.
  if (!state.isLoaded || !state.hasCheckedOnboarding || state.isOnboardingOpen || state.machine === 'loading') return 'wait';
  // Another machine, or one it couldn't find out: never taken for this computer's first run.
  if (state.machine !== 'this') return 'skip';
  return 'run';
}

/** What the window's connection state says about the machine it shows, for the Welcome check. */
export function windowMachineForWelcome(known: boolean, readFailed: boolean, mode: string): WindowMachine {
  if (known) return mode === 'remote' ? 'other' : 'this';
  return readFailed ? 'unreadable' : 'loading';
}
