import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

export type NativeCheckpointState = { ready: true } | { ready: false; reason: string };

const hookSchema = boundary.object({
  session_id: boundary.string,
  hook_event_name: boundary.string,
  background_tasks: boundary.optional(boundary.array(boundary.jsonObject)),
  session_crons: boundary.optional(boundary.array(boundary.jsonObject)),
});

/** A provider's structured checkpoint is necessary, but the native owner must
 * also freeze input, drain queued submissions and verify process release.
 * This observer never treats a quiet terminal screen as a checkpoint. */
export class NativeCheckpoint {
  private state: NativeCheckpointState = {
    ready: false,
    reason: 'The agent has not reported a transferable checkpoint. Wait for its current turn to finish.',
  };

  constructor(private readonly conversationId: string) {}

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native hook payloads are decoded immediately with hookSchema.
  observe(input: unknown): void {
    const event = decodeOptionalBoundary(input, hookSchema);
    if (!event || event.session_id !== this.conversationId) return;
    this.input();
    if (event.hook_event_name === 'Stop') {
      if (event.background_tasks?.length) {
        this.state = { ready: false, reason: 'Background work is still running. Wait for it to finish before switching.' };
      } else if (event.background_tasks && event.session_crons?.length === 0) {
        this.state = { ready: true };
      } else if (event.session_crons?.length) {
        this.state = { ready: false, reason: 'The agent has scheduled work. Remove its scheduled wakeups before switching.' };
      }
    } else if (event.hook_event_name === 'PermissionRequest') {
      this.state = { ready: false, reason: 'The agent is waiting for permission. Answer in the current view before switching.' };
    }
  }

  input(): void {
    this.state = { ready: false, reason: 'The agent has unconfirmed work. Wait for a complete checkpoint before switching.' };
  }

  read(): NativeCheckpointState {
    return { ...this.state };
  }
}
