/**
 * What the window's first read of its connection says (review 1781 round 7): a state to show; no
 * data, which means this computer (a window always starts on it), so the Welcome check and the
 * startup dialogs never wait on it forever; or a refusal.
 */
export function connectionReadOutcome<State>(response: { success: boolean; data?: State | null; error?: string }): 'state' | 'local' | 'failed' {
  if (!response.success) return 'failed';
  return response.data ? 'state' : 'local';
}
