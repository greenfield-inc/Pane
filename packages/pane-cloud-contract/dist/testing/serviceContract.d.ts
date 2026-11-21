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
}
/** The service API contract: what the service must do for Pane. */
export declare function serviceContractCases(target: ServiceContractTarget): ContractCase[];
export {};
