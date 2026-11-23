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
 * `create` also makes the VM's relay identity and a first one-time pairing link before the VM boots
 * (PREBOOT_RELAY_FILES) and returns them, so the service can vouch while the VM boots (D-104).
 * `create_pairing_link` asks the running VM's Pane for another link, for a later pairing.
 */
export declare const FLEET_OPERATIONS: {
    readonly create: {
        readonly runsOn: "host";
        readonly parameters: z.ZodObject<{}, z.core.$strict>;
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
}>;
export declare const OperationPayload: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"create">;
    parameters: z.ZodObject<{}, z.core.$strict>;
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
}, z.core.$strict>], "operation">;
export type OperationPayload = z.infer<typeof OperationPayload>;
export declare const OperationSignature: z.ZodObject<{
    keyId: z.ZodString;
    algorithm: z.ZodLiteral<"ECDSA_SHA_256">;
    value: z.ZodBase64;
}, z.core.$strict>;
export declare const OperationEnvelope: z.ZodObject<{
    payload: z.ZodDiscriminatedUnion<[z.ZodObject<{
        operation: z.ZodLiteral<"create">;
        parameters: z.ZodObject<{}, z.core.$strict>;
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
    }, z.core.$strict>], "operation">;
    signature: z.ZodObject<{
        keyId: z.ZodString;
        algorithm: z.ZodLiteral<"ECDSA_SHA_256">;
        value: z.ZodBase64;
    }, z.core.$strict>;
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
export declare function signOperation(payload: OperationPayload, signer: OperationSigner): Promise<OperationEnvelope>;
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
    user: "user";
    review: "review";
    host_maintenance: "host_maintenance";
    host_lost: "host_lost";
    failed: "failed";
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
        user: "user";
        review: "review";
        host_maintenance: "host_maintenance";
        host_lost: "host_lost";
        failed: "failed";
    }>>;
    hostId: z.ZodNullable<z.ZodString>;
    memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
    paneVersion: z.ZodNullable<z.ZodString>;
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
/**
 * What the host writes onto a new VM's secrets volume at assignment, before the first boot (D-104),
 * as paths under the volume's root (the guest's PANE_SECRETS_DIR). Pane uses this key as its relay
 * key and accepts this one-time secret as a pairing link, so pairing needs no step after the
 * daemon's socket appears. The host keeps the private key only on the volume, and the secret only
 * as its hash there and in `create`'s result for the service.
 */
export declare const PREBOOT_RELAY_FILES: {
    /** The VM's relay key: a P-256 private key, PKCS#8 PEM. Its public key's fingerprint is the identity `create` returns. */
    readonly key: "relay/computer-key.pem";
    /** The first pairing link's secret, as PrebootPairing JSON. */
    readonly pairing: "relay/pairing.json";
};
/** `relay/pairing.json`: the SHA-256 (hex) of the one-time secret in `create`'s link, and when the link expires. */
export declare const PrebootPairing: z.ZodObject<{
    sha256: z.ZodString;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>;
export type PrebootPairing = z.infer<typeof PrebootPairing>;
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
    }>;
    status: z.ZodEnum<{
        running: "running";
        failed: "failed";
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
        user: "user";
        review: "review";
        host_maintenance: "host_maintenance";
        host_lost: "host_lost";
        failed: "failed";
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
        }>;
        status: z.ZodEnum<{
            running: "running";
            failed: "failed";
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
        }>;
        status: z.ZodEnum<{
            running: "running";
            failed: "failed";
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
            user: "user";
            review: "review";
            host_maintenance: "host_maintenance";
            host_lost: "host_lost";
            failed: "failed";
        }>>;
        hostId: z.ZodNullable<z.ZodString>;
        memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        paneVersion: z.ZodNullable<z.ZodString>;
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
                user: "user";
                review: "review";
                host_maintenance: "host_maintenance";
                host_lost: "host_lost";
                failed: "failed";
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
        operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "create_pairing_link";
        status: "running" | "failed" | "accepted" | "succeeded";
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
    getOperation: (requestId: string) => Promise<{
        requestId: string;
        vmId: string;
        operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "create_pairing_link";
        status: "running" | "failed" | "accepted" | "succeeded";
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
        stateReason: "user" | "review" | "host_maintenance" | "host_lost" | "failed" | null;
        hostId: string | null;
        memoryGiB: 8 | 16;
        paneVersion: string | null;
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
            reason: "user" | "review" | "host_maintenance" | "host_lost" | "failed" | null;
            requestId: string | null;
            at: string;
        }[];
        nextCursor: string | null;
    }>;
};
export type FleetClient = ReturnType<typeof createFleetClient>;
export {};
