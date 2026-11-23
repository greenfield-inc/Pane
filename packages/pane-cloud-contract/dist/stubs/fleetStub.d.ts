import { type PaneRelease } from '../fleet';
import type { GitHubTokenRecord } from '../sealing';
import { type RunningStub } from './server';
export interface FleetStubOptions {
    /** Service signing keys the stub trusts, by key id (PEM public keys). */
    trustedKeys: Record<string, string>;
    /** Releases update_pane and bootstrap may install. */
    publishedReleases: PaneRelease[];
    /** This host's id; operations signed for another host are refused with wrong_host. Default `stub-host-1`. */
    hostId?: string;
    now?: () => Date;
}
export interface FleetStub extends RunningStub {
    /** The fleet stopping a VM on its own (host maintenance or host loss). */
    hostStop(vmId: string, reason: 'host_maintenance' | 'host_lost'): void;
    setCpuSecondsUsed(vmId: string, seconds: number): void;
    /** The VM's clone failing now with git's message, as a sign-in or network error does. */
    failClone(vmId: string, message: string): void;
    /** The GitHub token the stub host opened onto the VM's secrets volume, from its create or latest retry_clone. */
    secretsVolumeToken(vmId: string): GitHubTokenRecord | null;
}
/**
 * An in-memory fleet that keeps the contract: every operation checks out or is refused exactly as the
 * host agent would. Operations finish at once.
 */
export declare function startFleetStub(options: FleetStubOptions): Promise<FleetStub>;
