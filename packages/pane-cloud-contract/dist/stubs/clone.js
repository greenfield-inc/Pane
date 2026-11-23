"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StubSealingKeys = exports.StubClone = void 0;
const sealing_1 = require("../sealing");
const errors_1 = require("../errors");
/** The steps a stub clone takes, one per read of its VM, so a poller sees progress and then the Pane. */
const STEPS = [
    { phase: 'receiving', percent: 0, line: 'Receiving objects:   0% (0/1200)' },
    { phase: 'receiving', percent: 45, line: 'Receiving objects:  45% (540/1200), 2.10 MiB | 9.80 MiB/s' },
    { phase: 'receiving', percent: 100, line: 'Receiving objects: 100% (1200/1200), 4.70 MiB | 10.20 MiB/s, done.' },
    { phase: 'resolving', percent: 100, line: 'Resolving deltas: 100% (610/610), done.' },
    { phase: 'checking_out', percent: 100, line: 'Updating files: 100% (214/214), done.' },
    { phase: 'creating_pane', percent: null, line: 'Creating the Pane' },
];
/** The repo as people name it: `owner/repo` from `https://github.com/owner/repo.git`. */
function repoName(repo) {
    return new URL(repo.url).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '') || new URL(repo.url).hostname;
}
/**
 * A stub clone. A repo whose path holds `does-not-exist` fails as git does for a missing repo; any
 * other repo succeeds after the steps above, and fail() fails it on the spot (a sign-in error, say).
 */
class StubClone {
    repo;
    iso;
    paneId;
    status;
    step = 0;
    constructor(repo, iso, paneId) {
        this.repo = repo;
        this.iso = iso;
        this.paneId = paneId;
        this.status = this.restart();
    }
    restart() {
        this.step = 0;
        this.status = { repo: repoName(this.repo), branch: this.repo.branch, state: 'cloning', phase: 'receiving', percent: 0, line: null, startedAt: this.iso(), finishedAt: null, error: null, paneId: null };
        return this.status;
    }
    /** Moves one step, then returns the status a read sees. */
    read() {
        if (this.status.state !== 'cloning')
            return this.status;
        if (this.repo.url.includes('does-not-exist')) {
            return this.fail(`Cloning into '${repoName(this.repo).split('/').at(-1) ?? 'repo'}'...\nremote: Repository not found.\nfatal: repository '${this.repo.url}/' not found`);
        }
        const step = STEPS[this.step];
        if (!step) {
            this.status = { ...this.status, state: 'ready', phase: null, percent: null, line: null, finishedAt: this.iso(), paneId: this.paneId };
            return this.status;
        }
        this.step += 1;
        this.status = { ...this.status, phase: step.phase, percent: step.percent, line: step.line };
        return this.status;
    }
    fail(message) {
        this.status = { ...this.status, state: 'failed', phase: null, percent: null, finishedAt: this.iso(), error: { message }, paneId: null };
        return this.status;
    }
}
exports.StubClone = StubClone;
const SEALING_KEY_LIFETIME_MS = 10 * 60_000;
/** Sealing keys a stub host holds, as a real host keeps each slot's and VM's private half. */
class StubSealingKeys {
    hostId;
    now;
    keys = new Map();
    counter = 0;
    constructor(hostId, now) {
        this.hostId = hostId;
        this.now = now;
    }
    async make(owner) {
        const pair = await (0, sealing_1.newSealingKeyPair)();
        this.counter += 1;
        const key = { keyId: `seal_${this.counter}_${pair.publicKey.slice(0, 8)}`, hostId: this.hostId, publicKey: pair.publicKey, expiresAt: new Date(this.now().getTime() + SEALING_KEY_LIFETIME_MS).toISOString() };
        this.keys.set(key.keyId, { key, pair, owner, used: false });
        return key;
    }
    /**
     * Uses a key once for `owner`, opening the sealed token with it when one came. Throws
     * sealing_key_expired for a key that is unknown, someone else's, used or past its time, and
     * invalid_request when the sealed token doesn't open with it. Neither message repeats the token.
     */
    async use(keyId, owner, sealed) {
        const held = this.keys.get(keyId);
        if (!held || held.owner !== owner || held.used || Date.parse(held.key.expiresAt) <= this.now().getTime()) {
            throw new errors_1.CloudApiError('sealing_key_expired', 'The sealing key for this request is no longer valid, so nothing was created or retried.', 'Ask for a new sealing key, seal the token to it, and send the request again.');
        }
        held.used = true;
        if (sealed === undefined)
            return null;
        const opened = await (0, sealing_1.openGitHubToken)(sealed, held.pair);
        if (!opened)
            throw new errors_1.CloudApiError('invalid_request', 'The sealed GitHub token does not open with its sealing key, so nothing was created or retried.', 'Seal {token, source, updatedAt} to the key the request names.');
        return opened;
    }
}
exports.StubSealingKeys = StubSealingKeys;
