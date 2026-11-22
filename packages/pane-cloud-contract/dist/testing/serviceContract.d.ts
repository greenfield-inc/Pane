import { type Plan } from '../service';
import { type ContractCase } from './cases';
type Who = 'member' | 'unverified' | 'waitlisted';
export interface ServiceContractTarget {
    baseUrl: string;
    /**
     * Signs in a test account and returns its token. `member` is invited, has finished sign-up, is on
     * the Free plan in its personal organization and has no Session VMs awake. `unverified` is invited
     * but has not finished the phone and card checks. `waitlisted` is not invited.
     */
    signIn(who: Who): Promise<string>;
    emails: Record<Who, string>;
    /** How long to wait for a VM to settle. Default 180 s. */
    timeoutMs?: number;
    /**
     * Test-mode setup the server offers. A case that needs a control it doesn't offer is skipped and
     * says so. `setClock` moves the service's clock forward only, so the clock case runs last.
     */
    controls?: Partial<ServiceContractControls>;
}
export interface ServiceContractControls {
    /** Stops a VM for review, as the automatic pause or a person's Suspend does. */
    pauseForReview(vmId: string): Promise<void> | void;
    /** How many VMs the host holds awake at once; null for no limit. */
    setCapacity(capacity: number | null): Promise<void> | void;
    /** Adds a test account to an organization with a role, as an accepted invitation does. */
    addMember(who: Who, organizationId: string, role: 'full_access' | 'view_only'): Promise<void> | void;
    /** Changes a test account's role in an organization, or removes it from the organization with null. */
    changeMember(who: Who, organizationId: string, role: 'full_access' | 'view_only' | null): Promise<void> | void;
    /** Puts an organization on a plan. */
    setPlan(organizationId: string, plan: Plan): Promise<void> | void;
    /** Gives a VM 16 GiB, as a resize does. */
    setMemoryGiB(vmId: string, memoryGiB: 16): Promise<void> | void;
    /** Sets the service's clock (ISO time), never backwards. */
    setClock(at: string): Promise<void> | void;
}
/** The service API contract: what the service must do for Pane. */
export declare function serviceContractCases(target: ServiceContractTarget): ContractCase[];
export {};
