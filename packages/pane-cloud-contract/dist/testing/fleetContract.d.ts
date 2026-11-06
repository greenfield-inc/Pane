import { type OperationSigner, type PaneRelease } from '../fleet';
import { type ContractCase } from './cases';
export interface LocalSigner {
    signer: OperationSigner;
    publicKeyPem: string;
}
/** A P-256 signing key held in memory, standing in for the service's KMS key in tests. */
export declare function createLocalSigner(keyId?: string): LocalSigner;
export interface FleetContractTarget {
    baseUrl: string;
    /** Credential for the fleet API (the service role's in production). */
    token: string;
    /** A key the fleet trusts. */
    signer: OperationSigner;
    /** A key the fleet does not trust. */
    untrustedSigner: OperationSigner;
    /** A published release the fleet will install. */
    release: PaneRelease;
    /** How long to wait for a machine or operation to settle. Default 120 s. */
    timeoutMs?: number;
}
/** The fleet API contract: what F2's host agent and scheduler must do for the service. */
export declare function fleetContractCases(target: FleetContractTarget): ContractCase[];
