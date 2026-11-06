import { type RunningStub } from './server';
export interface StubAccount {
    githubLogin: string;
    name?: string;
    /** In the invite-only cohort. Others are waitlisted until a team invites them. */
    cohort: boolean;
}
export interface ServiceStubOptions {
    accounts: StubAccount[];
    /** Published Pane versions, oldest first; the last is what create and update_pane install by default. */
    paneVersions?: string[];
    /** The beta's public end date and its links; omitted, no end date is set. */
    beta?: {
        endsAt: string;
        announcementUrl?: string;
        ownAwsTemplateUrl?: string;
    };
    now?: () => Date;
}
export interface ServiceStub extends RunningStub {
    /** The person entering the device code on GitHub and approving. */
    approveDevice(userCode: string, githubLogin: string): void;
    denyDevice(userCode: string): void;
    /** The fleet stopping a machine on its own; logged with actor `host`. */
    hostStop(machineId: string, reason: 'idle' | 'memory_pressure' | 'host_maintenance'): void;
    joinTailnet(machineId: string): void;
    setCpuSecondsUsed(machineId: string, seconds: number): void;
}
/**
 * An in-memory Pane Cloud service that keeps the contract, for building the desktop adapter and for
 * the contract tests. Machines start and stop at once.
 */
export declare function startServiceStub(options: ServiceStubOptions): Promise<ServiceStub>;
