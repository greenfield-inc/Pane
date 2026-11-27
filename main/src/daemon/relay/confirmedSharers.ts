/**
 * The linked computers that have said which devices they still share with (`relay:client:read-devices`)
 * since this computer started or woke. A read-only token handed out for one works only once it has, so
 * a device removed there while this computer slept gets nothing here, even when it asks first.
 */
class ConfirmedSharers {
  private readonly ids = new Set<string>();

  confirm(computerId: string): void {
    this.ids.add(computerId);
  }

  has(computerId: string): boolean {
    return this.ids.has(computerId);
  }

  /** This computer is going to sleep. */
  clear(): void {
    this.ids.clear();
  }
}

export const confirmedSharers = new ConfirmedSharers();
