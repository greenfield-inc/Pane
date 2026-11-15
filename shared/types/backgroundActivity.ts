/** When Pane pauses its own background checks (ports, usage) while nobody is looking. */
export const BACKGROUND_ACTIVITY_PROFILES = ['performance', 'balanced', 'batterySaver'] as const;
export type BackgroundActivityProfile = typeof BACKGROUND_ACTIVITY_PROFILES[number];
export const DEFAULT_BACKGROUND_ACTIVITY: BackgroundActivityProfile = 'balanced';
