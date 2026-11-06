import { type PaneRelease } from '../fleet';
import { type RunningStub } from './server';
export interface FleetStubOptions {
    /** Service signing keys the stub trusts, by key id (PEM public keys). */
    trustedKeys: Record<string, string>;
    /** Releases update_pane and bootstrap may install. */
    publishedReleases: PaneRelease[];
    now?: () => Date;
}
export interface FleetStub extends RunningStub {
    /** The fleet stopping a machine on its own (idle, memory pressure, host maintenance). */
    hostStop(machineId: string, reason: 'idle' | 'memory_pressure' | 'host_maintenance' | 'abuse'): void;
    /** The machine's user opening its Tailscale login link. */
    joinTailnet(machineId: string): void;
    setCpuSecondsUsed(machineId: string, seconds: number): void;
}
/**
 * An in-memory fleet that keeps the contract: every operation checks out or is refused exactly as the
 * host agent would. Operations finish at once.
 */
export declare function startFleetStub(options: FleetStubOptions): Promise<FleetStub>;
