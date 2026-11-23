import type { CloneRepo, CloneStatus, FleetSealingKey } from '../fleet';
import { type GitHubTokenRecord } from '../sealing';
/**
 * A stub clone. A repo whose path holds `does-not-exist` fails as git does for a missing repo; any
 * other repo succeeds after the steps above, and fail() fails it on the spot (a sign-in error, say).
 */
export declare class StubClone {
    private readonly repo;
    private readonly iso;
    private readonly paneId;
    status: CloneStatus;
    private step;
    constructor(repo: CloneRepo, iso: () => string, paneId: string);
    restart(): CloneStatus;
    /** Moves one step, then returns the status a read sees. */
    read(): CloneStatus;
    fail(message: string): CloneStatus;
}
/** Sealing keys a stub host holds, as a real host keeps each slot's and VM's private half. */
export declare class StubSealingKeys {
    private readonly hostId;
    private readonly now;
    private readonly keys;
    private counter;
    constructor(hostId: string, now: () => Date);
    make(owner: string): Promise<FleetSealingKey>;
    /**
     * Uses a key once for `owner`, opening the sealed token with it when one came. Throws
     * sealing_key_expired for a key that is unknown, someone else's, used or past its time, and
     * invalid_request when the sealed token doesn't open with it. Neither message repeats the token.
     */
    use(keyId: string, owner: string, sealed: string | undefined): Promise<GitHubTokenRecord | null>;
}
