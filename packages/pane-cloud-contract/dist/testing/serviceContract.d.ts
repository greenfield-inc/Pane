import { type ContractCase } from './cases';
type Who = 'owner' | 'teammate' | 'outsider';
export interface ServiceContractTarget {
    baseUrl: string;
    /**
     * Signs in a test account and returns its token. `owner` is in the cohort and owns a team with no
     * other members; `teammate` and `outsider` are waitlisted and on no team.
     */
    signIn(who: Who): Promise<string>;
    logins: Record<Who, string>;
    /** How long to wait for a machine to settle. Default 180 s (journey 2's 3 minutes). */
    timeoutMs?: number;
}
/** The service API contract: what S1 must do for the desktop adapter. */
export declare function serviceContractCases(target: ServiceContractTarget): ContractCase[];
export {};
