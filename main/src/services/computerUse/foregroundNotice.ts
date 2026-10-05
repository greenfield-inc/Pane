import { Notification } from 'electron';

/**
 * Shown on the target machine before an agent's opted-in foreground action moves focus. Returns
 * the notice text, which also goes in the agent's tool result: the line the agent's pane shows.
 */
export async function showComputerUseForegroundNotice({ agent, app }: { agent: string; app: string }): Promise<string> {
  // Headless Linux may have no notification server.
  if (Notification.isSupported()) {
    new Notification({ title: 'Pane', body: `${agent} is bringing ${app} to the front`, silent: true }).show();
  }
  return `Pane: ${agent} is bringing ${app} to the front`;
}
