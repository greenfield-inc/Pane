export interface ReplaceableNotification {
  close: () => void;
  onclose: ((event: Event) => void) | null;
}

/**
 * Keeps one desktop notification per tag. Chromium's `tag` replacement is not
 * honoured by every OS notification center Electron uses, so a new
 * notification closes the one it replaces itself.
 */
export class NotificationsByTag<T extends ReplaceableNotification> {
  private readonly shown = new Map<string, T>();

  /** Close the notification shown under `tag`, then remember `next` in its place. */
  replace(tag: string | undefined, next: T): void {
    if (!tag) return;
    const previous = this.shown.get(tag);
    if (previous && previous !== next) previous.close();
    this.shown.set(tag, next);
    next.onclose = () => {
      if (this.shown.get(tag) === next) this.shown.delete(tag);
    };
  }

  size(): number {
    return this.shown.size;
  }
}

/** One notification per Pane: a new alert from any of its tabs replaces the last one. */
export function paneNotificationTag(paneId: string): string {
  return `pane:pane:${paneId}`;
}
