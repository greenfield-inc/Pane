import { z } from 'zod';
import { type ClientConfig } from './http';
/** A Session VM's memory. Every VM is created at 8 GiB; growing to 16 GiB comes later (resize). */
export declare const VmMemoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
export type VmMemoryGiB = z.infer<typeof VmMemoryGiB>;
/**
 * The only files collect_diagnostics reads, on the guest. Globs match file names only. Nothing under
 * a user's home other than Pane's own logs is read.
 */
export declare const DIAGNOSTIC_FILES: readonly ["/var/log/pane-cloud/guest-agent.log", "/var/log/pane-cloud/bootstrap.log", "/home/pane/.pane/logs/pane-*.log"];
/** Longest time between an operation's issuedAt and expiresAt. */
export declare const MAX_OPERATION_LIFETIME_SECONDS = 300;
/** Allowed clock difference between the service and a host when checking issuedAt. */
export declare const CLOCK_SKEW_SECONDS = 30;
export declare const VmId: z.ZodString;
/** A published Pane release. update_pane and bootstrap install exactly this .deb, or refuse. */
export declare const PaneRelease: z.ZodObject<{
    version: z.ZodString;
    arch: z.ZodLiteral<"arm64">;
    debSha256: z.ZodString;
}, z.core.$strict>;
export type PaneRelease = z.infer<typeof PaneRelease>;
/** Names one sealing key pair the host made: a free slot's for create, a VM's own for retry_clone. */
export declare const SealingKeyId: z.ZodString;
/** A sealing public key: raw 32-byte X25519, base64url without padding. */
export declare const SealingPublicKey: z.ZodString;
/**
 * A libsodium sealed box (crypto_box_seal) to one sealing key, base64url without padding. It holds
 * the JSON `{"token","source","updatedAt"}`: the person's GitHub token, the machine it came from and
 * when it last changed. Only the host that made the key can open it. Every route passes it on
 * unopened and never stores, logs or returns it.
 */
export declare const SealedSecret: z.ZodString;
/** The repo a new Session clones: an https URL with no credentials in it, and the branch to check out. */
export declare const CloneRepo: z.ZodObject<{
    url: z.ZodURL;
    branch: z.ZodString;
}, z.core.$strict>;
export type CloneRepo = z.infer<typeof CloneRepo>;
/** Whether a GitHub token may go with this repo: the guest's credential helper answers only for github.com. */
export declare function isGitHubRepo(repo: CloneRepo): boolean;
/** The SHA-256 of a sealed secret, which a signed operation carries to bind the sealed copy sent beside it. */
export declare function sealedSecretDigest(sealed: string): string;
/**
 * The clone of a new Session's repo, as the guest reports it. It starts at boot, beside the daemon:
 * a blobless clone, then `runpane panes create --no-fetch`, whose Pane id the app opens. `line` is
 * git's last progress line and `error` git's own message; the guest strips anything that looks like a
 * credential from both. A failed clone creates no Pane and leaves the VM running for retry_clone.
 */
export declare const CloneStatus: z.ZodObject<{
    repo: z.ZodString;
    branch: z.ZodString;
    state: z.ZodEnum<{
        cloning: "cloning";
        ready: "ready";
        failed: "failed";
    }>;
    phase: z.ZodNullable<z.ZodEnum<{
        receiving: "receiving";
        resolving: "resolving";
        checking_out: "checking_out";
        creating_pane: "creating_pane";
    }>>;
    percent: z.ZodNullable<z.ZodNumber>;
    line: z.ZodNullable<z.ZodString>;
    startedAt: z.ZodISODateTime;
    finishedAt: z.ZodNullable<z.ZodISODateTime>;
    error: z.ZodNullable<z.ZodObject<{
        message: z.ZodString;
    }, z.core.$strict>>;
    paneId: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export type CloneStatus = z.infer<typeof CloneStatus>;
/** A sealing key the host made, with the host that holds its private half. */
export declare const FleetSealingKey: z.ZodObject<{
    keyId: z.ZodString;
    hostId: z.ZodString;
    publicKey: z.ZodString;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>;
export type FleetSealingKey = z.infer<typeof FleetSealingKey>;
/**
 * Why the service stops a VM; the fleet records it as the VM's stateReason. `user`: its creator
 * stopped it. `review`: paused for review, automatically or by a person's Suspend (one state, D-68).
 * Stops the fleet makes on its own (host maintenance, host loss) set their own reason.
 */
export declare const StopCause: z.ZodEnum<{
    user: "user";
    review: "review";
}>;
/**
 * The allow-list. Lifecycle operations run on the host; guest operations run inside the VM through
 * the guest agent. Nothing else exists: no shell command, no file write, no access grant. `create`
 * makes an 8 GiB, 4 vCPU VM and starts it; `stop` keeps its disk; `start` boots it from that disk.
 * `create_pairing_link` asks the VM's Pane for a one-time pairing link and its relay identity.
 * `retry_clone` runs a failed clone of the Session's repo again.
 */
export declare const FLEET_OPERATIONS: {
    readonly create: {
        readonly runsOn: "host";
        readonly parameters: z.ZodObject<{
            sealingKeyId: z.ZodOptional<z.ZodString>;
            repo: z.ZodOptional<z.ZodObject<{
                url: z.ZodURL;
                branch: z.ZodString;
            }, z.core.$strict>>;
            sealedGitHubTokenSha256: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
    };
    readonly start: {
        readonly runsOn: "host";
        readonly parameters: z.ZodObject<{}, z.core.$strict>;
    };
    readonly stop: {
        readonly runsOn: "host";
        readonly parameters: z.ZodObject<{
            cause: z.ZodEnum<{
                user: "user";
                review: "review";
            }>;
        }, z.core.$strict>;
    };
    readonly delete: {
        readonly runsOn: "host";
        readonly parameters: z.ZodObject<{}, z.core.$strict>;
    };
    readonly bootstrap: {
        readonly runsOn: "guest";
        readonly parameters: z.ZodObject<{
            release: z.ZodObject<{
                version: z.ZodString;
                arch: z.ZodLiteral<"arm64">;
                debSha256: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
    };
    readonly update_pane: {
        readonly runsOn: "guest";
        readonly parameters: z.ZodObject<{
            release: z.ZodObject<{
                version: z.ZodString;
                arch: z.ZodLiteral<"arm64">;
                debSha256: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
    };
    readonly prepare_to_stop: {
        readonly runsOn: "guest";
        readonly parameters: z.ZodObject<{}, z.core.$strict>;
    };
    readonly collect_diagnostics: {
        readonly runsOn: "guest";
        readonly parameters: z.ZodObject<{}, z.core.$strict>;
    };
    readonly create_pairing_link: {
        readonly runsOn: "guest";
        readonly parameters: z.ZodObject<{}, z.core.$strict>;
    };
    readonly retry_clone: {
        readonly runsOn: "guest";
        readonly parameters: z.ZodObject<{
            sealingKeyId: z.ZodOptional<z.ZodString>;
            sealedGitHubTokenSha256: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
    };
};
export type FleetOperationName = keyof typeof FLEET_OPERATIONS;
export declare const FleetOperationName: z.ZodEnum<{
    create: "create";
    start: "start";
    stop: "stop";
    delete: "delete";
    bootstrap: "bootstrap";
    update_pane: "update_pane";
    prepare_to_stop: "prepare_to_stop";
    collect_diagnostics: "collect_diagnostics";
    create_pairing_link: "create_pairing_link";
    retry_clone: "retry_clone";
}>;
export declare const OperationPayload: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"create">;
    parameters: z.ZodObject<{
        sealingKeyId: z.ZodOptional<z.ZodString>;
        repo: z.ZodOptional<z.ZodObject<{
            url: z.ZodURL;
            branch: z.ZodString;
        }, z.core.$strict>>;
        sealedGitHubTokenSha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"start">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"stop">;
    parameters: z.ZodObject<{
        cause: z.ZodEnum<{
            user: "user";
            review: "review";
        }>;
    }, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"delete">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"bootstrap">;
    parameters: z.ZodObject<{
        release: z.ZodObject<{
            version: z.ZodString;
            arch: z.ZodLiteral<"arm64">;
            debSha256: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"update_pane">;
    parameters: z.ZodObject<{
        release: z.ZodObject<{
            version: z.ZodString;
            arch: z.ZodLiteral<"arm64">;
            debSha256: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"prepare_to_stop">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"collect_diagnostics">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"create_pairing_link">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"retry_clone">;
    parameters: z.ZodObject<{
        sealingKeyId: z.ZodOptional<z.ZodString>;
        sealedGitHubTokenSha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    requestId: z.ZodUUID;
    hostId: z.ZodString;
    vmId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>], "operation">;
export type OperationPayload = z.infer<typeof OperationPayload>;
export declare const OperationSignature: z.ZodObject<{
    keyId: z.ZodString;
    algorithm: z.ZodLiteral<"ECDSA_SHA_256">;
    value: z.ZodBase64;
}, z.core.$strict>;
/** A sealed GitHub token sent beside the signed payload; the payload signs its digest. */
export declare const SealedSecrets: z.ZodObject<{
    githubToken: z.ZodString;
}, z.core.$strict>;
export type SealedSecrets = z.infer<typeof SealedSecrets>;
export declare const OperationEnvelope: z.ZodObject<{
    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
        operation: z.ZodLiteral<"create">;
        parameters: z.ZodObject<{
            sealingKeyId: z.ZodOptional<z.ZodString>;
            repo: z.ZodOptional<z.ZodObject<{
                url: z.ZodURL;
                branch: z.ZodString;
            }, z.core.$strict>>;
            sealedGitHubTokenSha256: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"start">;
        parameters: z.ZodObject<{}, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"stop">;
        parameters: z.ZodObject<{
            cause: z.ZodEnum<{
                user: "user";
                review: "review";
            }>;
        }, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"delete">;
        parameters: z.ZodObject<{}, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"bootstrap">;
        parameters: z.ZodObject<{
            release: z.ZodObject<{
                version: z.ZodString;
                arch: z.ZodLiteral<"arm64">;
                debSha256: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"update_pane">;
        parameters: z.ZodObject<{
            release: z.ZodObject<{
                version: z.ZodString;
                arch: z.ZodLiteral<"arm64">;
                debSha256: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"prepare_to_stop">;
        parameters: z.ZodObject<{}, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"collect_diagnostics">;
        parameters: z.ZodObject<{}, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"create_pairing_link">;
        parameters: z.ZodObject<{}, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"retry_clone">;
        parameters: z.ZodObject<{
            sealingKeyId: z.ZodOptional<z.ZodString>;
            sealedGitHubTokenSha256: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        requestId: z.ZodUUID;
        hostId: z.ZodString;
        vmId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>], "operation">;
    signature: z.ZodObject<{
        keyId: z.ZodString;
        algorithm: z.ZodLiteral<"ECDSA_SHA_256">;
        value: z.ZodBase64;
    }, z.core.$strict>;
    sealed: z.ZodOptional<z.ZodObject<{
        githubToken: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type OperationEnvelope = z.infer<typeof OperationEnvelope>;
/**
 * What POST /v1/operations accepts before verifyOperation checks it: any operation name, so an
 * unknown one is refused as operation_not_allowed rather than as a malformed request.
 */
export declare const SubmittedEnvelope: z.ZodObject<{
    payload: z.ZodObject<{
        operation: z.ZodString;
    }, z.core.$loose>;
    signature: z.ZodObject<{}, z.core.$loose>;
    sealed: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
}, z.core.$strict>;
export type SubmittedEnvelope = z.infer<typeof SubmittedEnvelope>;
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
    [key: string]: JsonValue;
}
/**
 * JSON with object keys sorted at every level and no whitespace: the bytes both sides sign and check.
 * Keys sort by UTF-16 code unit, as JavaScript's default sort does.
 */
export declare function canonicalJson(value: JsonValue): string;
/** The exact bytes the service signs for an operation: a domain line, then the payload's canonical JSON. */
export declare function operationSigningBytes(payload: JsonObject): Buffer;
/** Something that signs bytes with a service key: AWS KMS in S1, a local key in tests. */
export interface OperationSigner {
    keyId: string;
    sign(bytes: Buffer): Promise<Buffer>;
}
export declare function signOperation(payload: OperationPayload, signer: OperationSigner, sealed?: SealedSecrets): Promise<OperationEnvelope>;
/**
 * The host's check, for a requestId it has not seen, that the sealed token sent beside the payload is
 * the one the payload signs. A resend of a requestId the host already recorded answers its first
 * outcome without it. Throws invalid_request; the message never repeats the sealed token.
 */
export declare function requireSealedSecrets(envelope: OperationEnvelope): SealedSecrets | null;
/**
 * The host agent's check of an envelope it received, before it runs anything. Throws CloudApiError:
 * operation_not_allowed or invalid_request for a payload outside the allow-list, signature_invalid
 * for an unknown key or a bad signature, operation_expired outside the payload's time window, and
 * wrong_host for an operation signed for another host.
 */
export declare function verifyOperation(envelope: SubmittedEnvelope, trustedKeys: Readonly<Record<string, string>>, hostId: string, now?: Date): OperationEnvelope;
export declare const FleetVmState: z.ZodEnum<{
    error: "error";
    creating: "creating";
    running: "running";
    stopping: "stopping";
    stopped: "stopped";
    starting: "starting";
    deleting: "deleting";
    deleted: "deleted";
}>;
/** Why a VM last stopped or failed; null while it runs normally. */
export declare const StateReason: z.ZodEnum<{
    failed: "failed";
    user: "user";
    review: "review";
    host_maintenance: "host_maintenance";
    host_lost: "host_lost";
}>;
export declare const FleetVm: z.ZodObject<{
    vmId: z.ZodString;
    state: z.ZodEnum<{
        error: "error";
        creating: "creating";
        running: "running";
        stopping: "stopping";
        stopped: "stopped";
        starting: "starting";
        deleting: "deleting";
        deleted: "deleted";
    }>;
    stateReason: z.ZodNullable<z.ZodEnum<{
        failed: "failed";
        user: "user";
        review: "review";
        host_maintenance: "host_maintenance";
        host_lost: "host_lost";
    }>>;
    hostId: z.ZodNullable<z.ZodString>;
    memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
    paneVersion: z.ZodNullable<z.ZodString>;
    clone: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        repo: z.ZodString;
        branch: z.ZodString;
        state: z.ZodEnum<{
            cloning: "cloning";
            ready: "ready";
            failed: "failed";
        }>;
        phase: z.ZodNullable<z.ZodEnum<{
            receiving: "receiving";
            resolving: "resolving";
            checking_out: "checking_out";
            creating_pane: "creating_pane";
        }>>;
        percent: z.ZodNullable<z.ZodNumber>;
        line: z.ZodNullable<z.ZodString>;
        startedAt: z.ZodISODateTime;
        finishedAt: z.ZodNullable<z.ZodISODateTime>;
        error: z.ZodNullable<z.ZodObject<{
            message: z.ZodString;
        }, z.core.$strict>>;
        paneId: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>>;
    updatedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type FleetVm = z.infer<typeof FleetVm>;
export declare const OperationError: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    next: z.ZodString;
}, z.core.$strict>;
/** The relay computer id a key fingerprint names: its first 80 bits in lowercase base32 (Pane's relay/PROTOCOL.md). */
export declare function relayComputerIdOf(fingerprint: string): string;
/**
 * A Session VM's relay identity: the name clients reach it at, `https://<computerId>.<domain>`, and
 * the key they pin. The VM's Pane makes the key on first use and keeps it on the Session disk.
 */
export declare const RelayIdentity: z.ZodObject<{
    computerId: z.ZodString;
    fingerprint: z.ZodString;
    domain: z.ZodString;
}, z.core.$strict>;
export type RelayIdentity = z.infer<typeof RelayIdentity>;
/**
 * A one-time link a device trades for its token on the VM (`https://<domain>/pair#s=…&c=<computerId>&n=…`),
 * with the identity the VM's Pane reported. The link works once, within 10 minutes. The fleet keeps
 * it only to answer a retried request, never in a log or an event.
 */
export declare const PairingLink: z.ZodObject<{
    relay: z.ZodObject<{
        computerId: z.ZodString;
        fingerprint: z.ZodString;
        domain: z.ZodString;
    }, z.core.$strict>;
    link: z.ZodURL;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>;
export type PairingLink = z.infer<typeof PairingLink>;
export declare const OperationStatus: z.ZodObject<{
    requestId: z.ZodUUID;
    vmId: z.ZodString;
    operation: z.ZodEnum<{
        create: "create";
        start: "start";
        stop: "stop";
        delete: "delete";
        bootstrap: "bootstrap";
        update_pane: "update_pane";
        prepare_to_stop: "prepare_to_stop";
        collect_diagnostics: "collect_diagnostics";
        create_pairing_link: "create_pairing_link";
        retry_clone: "retry_clone";
    }>;
    status: z.ZodEnum<{
        failed: "failed";
        running: "running";
        accepted: "accepted";
        succeeded: "succeeded";
    }>;
    error: z.ZodNullable<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        next: z.ZodString;
    }, z.core.$strict>>;
    result: z.ZodNullable<z.ZodUnion<readonly [z.ZodObject<{
        files: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            bytes: z.ZodNumber;
        }, z.core.$strict>>;
        archiveKey: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        relay: z.ZodObject<{
            computerId: z.ZodString;
            fingerprint: z.ZodString;
            domain: z.ZodString;
        }, z.core.$strict>;
        link: z.ZodURL;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>]>>;
    acceptedAt: z.ZodISODateTime;
    finishedAt: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strict>;
export type OperationStatus = z.infer<typeof OperationStatus>;
/** One VM's resource use for a UTC day, for the abuse signals and the per-VM graphs. */
export declare const VmMetrics: z.ZodObject<{
    vmId: z.ZodString;
    day: z.ZodISODate;
    cpuSecondsUsed: z.ZodNumber;
    memoryResidentMiB: z.ZodNumber;
    diskUsedBytes: z.ZodNumber;
    egressBytes: z.ZodNumber;
    sampledAt: z.ZodISODateTime;
}, z.core.$strict>;
export type VmMetrics = z.infer<typeof VmMetrics>;
/**
 * What the fleet did, in order: every state change (with its time, the service meters agent-hours
 * from these) and every finished operation, including stops the fleet made on its own.
 */
export declare const FleetEvent: z.ZodObject<{
    id: z.ZodString;
    vmId: z.ZodString;
    kind: z.ZodEnum<{
        state_changed: "state_changed";
        operation_finished: "operation_finished";
    }>;
    state: z.ZodNullable<z.ZodEnum<{
        error: "error";
        creating: "creating";
        running: "running";
        stopping: "stopping";
        stopped: "stopped";
        starting: "starting";
        deleting: "deleting";
        deleted: "deleted";
    }>>;
    reason: z.ZodNullable<z.ZodEnum<{
        failed: "failed";
        user: "user";
        review: "review";
        host_maintenance: "host_maintenance";
        host_lost: "host_lost";
    }>>;
    requestId: z.ZodNullable<z.ZodUUID>;
    at: z.ZodISODateTime;
}, z.core.$strict>;
export type FleetEvent = z.infer<typeof FleetEvent>;
export declare const fleetRoutes: {
    submitOperation: import("./http").Route<z.ZodObject<{
        payload: z.ZodObject<{
            operation: z.ZodString;
        }, z.core.$loose>;
        signature: z.ZodObject<{}, z.core.$loose>;
        sealed: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    }, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        requestId: z.ZodUUID;
        vmId: z.ZodString;
        operation: z.ZodEnum<{
            create: "create";
            start: "start";
            stop: "stop";
            delete: "delete";
            bootstrap: "bootstrap";
            update_pane: "update_pane";
            prepare_to_stop: "prepare_to_stop";
            collect_diagnostics: "collect_diagnostics";
            create_pairing_link: "create_pairing_link";
            retry_clone: "retry_clone";
        }>;
        status: z.ZodEnum<{
            failed: "failed";
            running: "running";
            accepted: "accepted";
            succeeded: "succeeded";
        }>;
        error: z.ZodNullable<z.ZodObject<{
            code: z.ZodString;
            message: z.ZodString;
            next: z.ZodString;
        }, z.core.$strict>>;
        result: z.ZodNullable<z.ZodUnion<readonly [z.ZodObject<{
            files: z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                bytes: z.ZodNumber;
            }, z.core.$strict>>;
            archiveKey: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            relay: z.ZodObject<{
                computerId: z.ZodString;
                fingerprint: z.ZodString;
                domain: z.ZodString;
            }, z.core.$strict>;
            link: z.ZodURL;
            expiresAt: z.ZodISODateTime;
        }, z.core.$strict>]>>;
        acceptedAt: z.ZodISODateTime;
        finishedAt: z.ZodNullable<z.ZodISODateTime>;
    }, z.core.$strict>>;
    /** Reserves a free slot for one create and returns the key its sealed token is sealed to. */
    reserveSealingKey: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        keyId: z.ZodString;
        hostId: z.ZodString;
        publicKey: z.ZodString;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    /** A fresh key for a running VM, for a retry_clone that carries a new sealed token. */
    createVmSealingKey: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        keyId: z.ZodString;
        hostId: z.ZodString;
        publicKey: z.ZodString;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    getOperation: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        requestId: z.ZodUUID;
        vmId: z.ZodString;
        operation: z.ZodEnum<{
            create: "create";
            start: "start";
            stop: "stop";
            delete: "delete";
            bootstrap: "bootstrap";
            update_pane: "update_pane";
            prepare_to_stop: "prepare_to_stop";
            collect_diagnostics: "collect_diagnostics";
            create_pairing_link: "create_pairing_link";
            retry_clone: "retry_clone";
        }>;
        status: z.ZodEnum<{
            failed: "failed";
            running: "running";
            accepted: "accepted";
            succeeded: "succeeded";
        }>;
        error: z.ZodNullable<z.ZodObject<{
            code: z.ZodString;
            message: z.ZodString;
            next: z.ZodString;
        }, z.core.$strict>>;
        result: z.ZodNullable<z.ZodUnion<readonly [z.ZodObject<{
            files: z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                bytes: z.ZodNumber;
            }, z.core.$strict>>;
            archiveKey: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            relay: z.ZodObject<{
                computerId: z.ZodString;
                fingerprint: z.ZodString;
                domain: z.ZodString;
            }, z.core.$strict>;
            link: z.ZodURL;
            expiresAt: z.ZodISODateTime;
        }, z.core.$strict>]>>;
        acceptedAt: z.ZodISODateTime;
        finishedAt: z.ZodNullable<z.ZodISODateTime>;
    }, z.core.$strict>>;
    getVm: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        vmId: z.ZodString;
        state: z.ZodEnum<{
            error: "error";
            creating: "creating";
            running: "running";
            stopping: "stopping";
            stopped: "stopped";
            starting: "starting";
            deleting: "deleting";
            deleted: "deleted";
        }>;
        stateReason: z.ZodNullable<z.ZodEnum<{
            failed: "failed";
            user: "user";
            review: "review";
            host_maintenance: "host_maintenance";
            host_lost: "host_lost";
        }>>;
        hostId: z.ZodNullable<z.ZodString>;
        memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        paneVersion: z.ZodNullable<z.ZodString>;
        clone: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            repo: z.ZodString;
            branch: z.ZodString;
            state: z.ZodEnum<{
                cloning: "cloning";
                ready: "ready";
                failed: "failed";
            }>;
            phase: z.ZodNullable<z.ZodEnum<{
                receiving: "receiving";
                resolving: "resolving";
                checking_out: "checking_out";
                creating_pane: "creating_pane";
            }>>;
            percent: z.ZodNullable<z.ZodNumber>;
            line: z.ZodNullable<z.ZodString>;
            startedAt: z.ZodISODateTime;
            finishedAt: z.ZodNullable<z.ZodISODateTime>;
            error: z.ZodNullable<z.ZodObject<{
                message: z.ZodString;
            }, z.core.$strict>>;
            paneId: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>>;
        updatedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    getMetrics: import("./http").Route<z.ZodUndefined, z.ZodObject<{
        day: z.ZodOptional<z.ZodISODate>;
    }, z.core.$strict>, z.ZodObject<{
        vmId: z.ZodString;
        day: z.ZodISODate;
        cpuSecondsUsed: z.ZodNumber;
        memoryResidentMiB: z.ZodNumber;
        diskUsedBytes: z.ZodNumber;
        egressBytes: z.ZodNumber;
        sampledAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    listEvents: import("./http").Route<z.ZodUndefined, z.ZodObject<{
        after: z.ZodOptional<z.ZodString>;
        limit: z.ZodOptional<z.ZodCoercedNumber<unknown>>;
    }, z.core.$strict>, z.ZodObject<{
        events: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            vmId: z.ZodString;
            kind: z.ZodEnum<{
                state_changed: "state_changed";
                operation_finished: "operation_finished";
            }>;
            state: z.ZodNullable<z.ZodEnum<{
                error: "error";
                creating: "creating";
                running: "running";
                stopping: "stopping";
                stopped: "stopped";
                starting: "starting";
                deleting: "deleting";
                deleted: "deleted";
            }>>;
            reason: z.ZodNullable<z.ZodEnum<{
                failed: "failed";
                user: "user";
                review: "review";
                host_maintenance: "host_maintenance";
                host_lost: "host_lost";
            }>>;
            requestId: z.ZodNullable<z.ZodUUID>;
            at: z.ZodISODateTime;
        }, z.core.$strict>>;
        nextCursor: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
};
/** The service's client for the fleet API. */
export declare function createFleetClient(config: ClientConfig): {
    submitOperation: (envelope: OperationEnvelope) => Promise<{
        requestId: string;
        vmId: string;
        operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "create_pairing_link" | "retry_clone";
        status: "failed" | "running" | "accepted" | "succeeded";
        error: {
            code: string;
            message: string;
            next: string;
        } | null;
        result: {
            relay: {
                computerId: string;
                fingerprint: string;
                domain: string;
            };
            link: string;
            expiresAt: string;
        } | {
            files: {
                path: string;
                bytes: number;
            }[];
            archiveKey: string;
        } | null;
        acceptedAt: string;
        finishedAt: string | null;
    }>;
    reserveSealingKey: () => Promise<{
        keyId: string;
        hostId: string;
        publicKey: string;
        expiresAt: string;
    }>;
    createVmSealingKey: (vmId: string) => Promise<{
        keyId: string;
        hostId: string;
        publicKey: string;
        expiresAt: string;
    }>;
    getOperation: (requestId: string) => Promise<{
        requestId: string;
        vmId: string;
        operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "create_pairing_link" | "retry_clone";
        status: "failed" | "running" | "accepted" | "succeeded";
        error: {
            code: string;
            message: string;
            next: string;
        } | null;
        result: {
            relay: {
                computerId: string;
                fingerprint: string;
                domain: string;
            };
            link: string;
            expiresAt: string;
        } | {
            files: {
                path: string;
                bytes: number;
            }[];
            archiveKey: string;
        } | null;
        acceptedAt: string;
        finishedAt: string | null;
    }>;
    getVm: (vmId: string) => Promise<{
        vmId: string;
        state: "error" | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted";
        stateReason: "failed" | "user" | "review" | "host_maintenance" | "host_lost" | null;
        hostId: string | null;
        memoryGiB: 8 | 16;
        paneVersion: string | null;
        clone: {
            repo: string;
            branch: string;
            state: "cloning" | "ready" | "failed";
            phase: "receiving" | "resolving" | "checking_out" | "creating_pane" | null;
            percent: number | null;
            line: string | null;
            startedAt: string;
            finishedAt: string | null;
            error: {
                message: string;
            } | null;
            paneId: string | null;
        } | null;
        updatedAt: string;
    }>;
    getMetrics: (vmId: string, day?: string) => Promise<{
        vmId: string;
        day: string;
        cpuSecondsUsed: number;
        memoryResidentMiB: number;
        diskUsedBytes: number;
        egressBytes: number;
        sampledAt: string;
    }>;
    listEvents: (after?: string, limit?: number) => Promise<{
        events: {
            id: string;
            vmId: string;
            kind: "state_changed" | "operation_finished";
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted" | null;
            reason: "failed" | "user" | "review" | "host_maintenance" | "host_lost" | null;
            requestId: string | null;
            at: string;
        }[];
        nextCursor: string | null;
    }>;
};
export type FleetClient = ReturnType<typeof createFleetClient>;
export {};
