import type { Keychain } from '../services/keychain';

/** In-memory stand-in for the OS keychain, so tests never touch a real login keychain. */
export class FakeKeychain implements Keychain {
  supported = true;
  private readonly items = new Map<string, string>();
  private readonly failures = new Map<string, string>();

  private id(service: string, account: string): string {
    return `${service}\u0000${account}`;
  }

  get size(): number {
    return this.items.size;
  }

  set(service: string, account: string, secret: string): void {
    this.items.set(this.id(service, account), secret);
  }

  get(service: string, account: string): string | undefined {
    return this.items.get(this.id(service, account));
  }

  /** Make reads of this item fail with `reason`, as a locked or denied keychain would. */
  fail(service: string, account: string, reason: string): void {
    this.failures.set(this.id(service, account), reason);
  }

  async read(service: string, account: string): Promise<string> {
    const reason = this.failures.get(this.id(service, account));
    if (reason) throw new Error(reason);
    const secret = this.get(service, account);
    if (secret === undefined) throw new Error('The specified item could not be found in the keychain.');
    return secret;
  }

  async write(service: string, account: string, secret: string): Promise<void> {
    this.set(service, account, secret);
  }

  async remove(service: string, account: string): Promise<void> {
    this.items.delete(this.id(service, account));
  }
}
