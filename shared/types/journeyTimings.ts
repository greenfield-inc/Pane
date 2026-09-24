/** Core journeys Pane times on-device. Timings never leave the machine. */
export const JOURNEYS = ['app_launch', 'create_pane', 'switch_pane', 'send_prompt'] as const;
export type Journey = typeof JOURNEYS[number];

export interface JourneyTimingSummary {
  journey: Journey;
  count: number;
  p50Ms: number;
  p75Ms: number;
}
