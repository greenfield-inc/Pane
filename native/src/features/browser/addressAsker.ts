/** A port whose phone-address request failed, and why. */
export interface AddressFailure {
  port: number;
  error: unknown;
}

/**
 * Asks the computer for each port's phone address once. A failed ask is not sent again on its
 * own, since the computer may have made the address anyway; it waits for the person's Try again.
 */
export class AddressAsker {
  private readonly asked = new Set<number>();

  constructor(
    private readonly send: (port: number) => Promise<unknown>,
    /** The latest failure, or null when a Try again clears it. */
    private readonly onFailure: (failure: AddressFailure | null) => void,
  ) {}

  ask(port: number): void {
    if (this.asked.has(port)) return;
    this.asked.add(port);
    this.send(port).catch((error: unknown) => this.onFailure({ port, error }));
  }

  /** The person's Try again: sends the ask for `port` once more. */
  retry(port: number): void {
    this.asked.delete(port);
    this.onFailure(null);
    this.ask(port);
  }
}
