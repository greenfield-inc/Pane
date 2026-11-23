import { type Account, type OrgRole, type Plan, type SessionVm } from '../service';
import type { GitHubTokenRecord } from '../sealing';
import { type RunningStub } from './server';
export interface StubAccount {
    email: string;
    name?: string;
    /** Invited to the beta. Others are waitlisted and can create nothing. */
    invited: boolean;
    /** Where the account is in sign-up. Default `ready`. */
    signupState?: Account['signupState'];
}
export interface ServiceStubOptions {
    accounts: StubAccount[];
    /** Published Pane versions, oldest first; the last is what create and update_pane install by default. */
    paneVersions?: string[];
    /** VMs the stub's one host holds awake at once; past it, create and start answer no_capacity. Default unlimited. */
    capacity?: number;
    now?: () => Date;
}
export interface ServiceStub extends RunningStub {
    /** The person signing in on the hosted page and approving. */
    approveDevice(userCode: string, email: string): void;
    denyDevice(userCode: string): void;
    /** An automatic pause or a person's Suspend: the VM stops with reason `review`, logged with actor `service`. */
    pauseForReview(vmId: string): void;
    /** VMs the stub's host holds awake at once; null for no limit. */
    setCapacity(capacity: number | null): void;
    /** Adds an account to an organization, as an accepted invitation will. */
    addMember(organizationId: string, email: string, role: Exclude<OrgRole, 'owner'>): void;
    /** Changes an account's role in an organization, or removes it from the organization with null. */
    changeMember(organizationId: string, email: string, role: Exclude<OrgRole, 'owner'> | null): void;
    /** Puts an organization on a plan, as a subscription will. */
    setPlan(organizationId: string, plan: Plan): void;
    /** Gives a VM 16 GiB (or back to 8), as a resize will; its later awake hours count at the new rate. */
    setMemoryGiB(vmId: string, memoryGiB: SessionVm['memoryGiB']): void;
    /** The VM's Pane losing its relay key and making a new one, so its next pairing reports another identity. */
    replaceRelayKey(vmId: string): void;
    /** The VM's clone failing now with git's message, as a sign-in or network error does. */
    failClone(vmId: string, message: string): void;
    /**
     * The GitHub token the host opened for this VM's secrets volume, from its create or its latest
     * retry: what the stub's host received, never something the service keeps.
     */
    hostGitHubToken(vmId: string): GitHubTokenRecord | null;
}
/**
 * An in-memory Pane Cloud service that keeps the contract, for building Pane against and for the
 * contract tests. Every account has a personal organization on the Free plan, and the awake limit spans
 * the account's organizations. VMs start and stop at
 * once, and agent-hours are counted from the stub's clock.
 */
export declare function startServiceStub(options: ServiceStubOptions): Promise<ServiceStub>;
