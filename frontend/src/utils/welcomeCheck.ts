/** What the window's Welcome check does now: run it, wait for loading or onboarding, or skip it for good. */
export type WelcomeCheckStep = 'run' | 'wait' | 'skip';

/**
 * The Welcome check runs once, on this window's own first load (QA 1781 F-5). A host switch reloads
 * the window's data, and the machine it shows has its own preferences, projects and Sessions: read
 * then, a machine with projects whose window never showed Welcome looked like a first run, and the
 * dialog opened over everything. So it never runs again once checked, and never for another machine.
 */
export function welcomeCheckStep(state: { checked: boolean; isLoaded: boolean; hasCheckedOnboarding: boolean; isOnboardingOpen: boolean; onOtherMachine: boolean }): WelcomeCheckStep {
  if (state.checked) return 'skip';
  if (!state.isLoaded || !state.hasCheckedOnboarding || state.isOnboardingOpen) return 'wait';
  if (state.onOtherMachine) return 'skip';
  return 'run';
}
