import { type Account } from '../service';
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
}
/**
 * An in-memory Pane Cloud service that keeps the contract, for building Pane against and for the
 * contract tests. Every account has a personal organization on the Free plan. VMs start and stop at
 * once, and agent-hours are counted from the stub's clock.
 */
export declare function startServiceStub(options: ServiceStubOptions): Promise<ServiceStub>;
