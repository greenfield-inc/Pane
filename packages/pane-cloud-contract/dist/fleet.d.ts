import { z } from 'zod';
import { type ClientConfig } from './http';
/** D-13's fair-use ceilings, the same for every machine. */
export declare const MACHINE_LIMITS: {
    readonly vcpu: 8;
    readonly memoryMiB: 16384;
    readonly diskGiB: 50;
    /** 12 vCPU-hours per UTC day; past it the machine runs at 0.5 vCPU until the next UTC midnight. */
    readonly dailyCpuSeconds: 43200;
    readonly throttledVcpu: 0.5;
    readonly monthlyEgressBytes: number;
};
/**
 * The only files collect_diagnostics reads, on the guest. Globs match file names only. Nothing under
 * a user's home other than Pane's own logs is read.
 */
export declare const DIAGNOSTIC_FILES: readonly ["/var/log/pane-cloud/guest-agent.log", "/var/log/pane-cloud/bootstrap.log", "/home/pane/.pane/logs/pane-*.log"];
/** Longest time between an operation's issuedAt and expiresAt. */
export declare const MAX_OPERATION_LIFETIME_SECONDS = 300;
/** Allowed clock difference between the service and a host when checking issuedAt. */
export declare const CLOCK_SKEW_SECONDS = 30;
export declare const MachineId: z.ZodString;
/** A published Pane release. update_pane and bootstrap install exactly this .deb, or refuse. */
export declare const PaneRelease: z.ZodObject<{
    version: z.ZodString;
    arch: z.ZodLiteral<"arm64">;
    debSha256: z.ZodString;
}, z.core.$strict>;
export type PaneRelease = z.infer<typeof PaneRelease>;
/**
 * Why the service stops a machine; the fleet records it as the machine's stateReason. Stops the
 * fleet makes on its own (idle, memory pressure, host maintenance, host loss) set their own reason.
 */
export declare const StopCause: z.ZodEnum<{
    user: "user";
    billing: "billing";
    end_of_beta: "end_of_beta";
    abuse: "abuse";
}>;
/**
 * The allow-list. Lifecycle operations run on the host; guest operations run inside the machine
 * through the guest agent. Nothing else exists: no shell command, no file write, no access grant.
 */
export declare const FLEET_OPERATIONS: {
    readonly create: {
        readonly runsOn: "host";
        readonly parameters: z.ZodObject<{}, z.core.$strict>;
    };
    readonly resume: {
        readonly runsOn: "host";
        readonly parameters: z.ZodObject<{}, z.core.$strict>;
    };
    readonly stop: {
        readonly runsOn: "host";
        readonly parameters: z.ZodObject<{
            cause: z.ZodEnum<{
                user: "user";
                billing: "billing";
                end_of_beta: "end_of_beta";
                abuse: "abuse";
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
};
export type FleetOperationName = keyof typeof FLEET_OPERATIONS;
export declare const FleetOperationName: z.ZodEnum<{
    create: "create";
    resume: "resume";
    stop: "stop";
    delete: "delete";
    bootstrap: "bootstrap";
    update_pane: "update_pane";
    prepare_to_stop: "prepare_to_stop";
    collect_diagnostics: "collect_diagnostics";
}>;
export declare const OperationPayload: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"create">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    machineId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"resume">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    machineId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"stop">;
    parameters: z.ZodObject<{
        cause: z.ZodEnum<{
            user: "user";
            billing: "billing";
            end_of_beta: "end_of_beta";
            abuse: "abuse";
        }>;
    }, z.core.$strict>;
    requestId: z.ZodUUID;
    machineId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"delete">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    machineId: z.ZodString;
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
    machineId: z.ZodString;
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
    machineId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"prepare_to_stop">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    machineId: z.ZodString;
    reason: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"collect_diagnostics">;
    parameters: z.ZodObject<{}, z.core.$strict>;
    requestId: z.ZodUUID;
    machineId: z.ZodString;
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
        machineId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"resume">;
        parameters: z.ZodObject<{}, z.core.$strict>;
        requestId: z.ZodUUID;
        machineId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"stop">;
        parameters: z.ZodObject<{
            cause: z.ZodEnum<{
                user: "user";
                billing: "billing";
                end_of_beta: "end_of_beta";
                abuse: "abuse";
            }>;
        }, z.core.$strict>;
        requestId: z.ZodUUID;
        machineId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"delete">;
        parameters: z.ZodObject<{}, z.core.$strict>;
        requestId: z.ZodUUID;
        machineId: z.ZodString;
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
        machineId: z.ZodString;
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
        machineId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"prepare_to_stop">;
        parameters: z.ZodObject<{}, z.core.$strict>;
        requestId: z.ZodUUID;
        machineId: z.ZodString;
        reason: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"collect_diagnostics">;
        parameters: z.ZodObject<{}, z.core.$strict>;
        requestId: z.ZodUUID;
        machineId: z.ZodString;
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
 * for an unknown key or a bad signature, operation_expired outside the payload's time window.
 */
export declare function verifyOperation(envelope: SubmittedEnvelope, trustedKeys: Readonly<Record<string, string>>, now?: Date): OperationEnvelope;
export declare const FleetMachineState: z.ZodEnum<{
    error: "error";
    creating: "creating";
    running: "running";
    stopping: "stopping";
    stopped: "stopped";
    resuming: "resuming";
    deleting: "deleting";
    deleted: "deleted";
}>;
/** Why a machine last stopped or failed; null while it runs normally. */
export declare const StateReason: z.ZodEnum<{
    user: "user";
    billing: "billing";
    end_of_beta: "end_of_beta";
    abuse: "abuse";
    idle: "idle";
    memory_pressure: "memory_pressure";
    host_maintenance: "host_maintenance";
    host_lost: "host_lost";
    failed: "failed";
}>;
/** The machine's place on the user's tailnet. It joins only from a login link its user opens. */
export declare const TailnetStatus: z.ZodObject<{
    status: z.ZodEnum<{
        awaiting_login: "awaiting_login";
        joined: "joined";
    }>;
    loginUrl: z.ZodNullable<z.ZodURL>;
    hostname: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const FleetMachine: z.ZodObject<{
    machineId: z.ZodString;
    state: z.ZodEnum<{
        error: "error";
        creating: "creating";
        running: "running";
        stopping: "stopping";
        stopped: "stopped";
        resuming: "resuming";
        deleting: "deleting";
        deleted: "deleted";
    }>;
    stateReason: z.ZodNullable<z.ZodEnum<{
        user: "user";
        billing: "billing";
        end_of_beta: "end_of_beta";
        abuse: "abuse";
        idle: "idle";
        memory_pressure: "memory_pressure";
        host_maintenance: "host_maintenance";
        host_lost: "host_lost";
        failed: "failed";
    }>>;
    hostId: z.ZodNullable<z.ZodString>;
    paneVersion: z.ZodNullable<z.ZodString>;
    tailnet: z.ZodObject<{
        status: z.ZodEnum<{
            awaiting_login: "awaiting_login";
            joined: "joined";
        }>;
        loginUrl: z.ZodNullable<z.ZodURL>;
        hostname: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    updatedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type FleetMachine = z.infer<typeof FleetMachine>;
export declare const OperationError: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    next: z.ZodString;
}, z.core.$strict>;
export declare const OperationStatus: z.ZodObject<{
    requestId: z.ZodUUID;
    machineId: z.ZodString;
    operation: z.ZodEnum<{
        create: "create";
        resume: "resume";
        stop: "stop";
        delete: "delete";
        bootstrap: "bootstrap";
        update_pane: "update_pane";
        prepare_to_stop: "prepare_to_stop";
        collect_diagnostics: "collect_diagnostics";
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
    result: z.ZodNullable<z.ZodObject<{
        files: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            bytes: z.ZodNumber;
        }, z.core.$strict>>;
        archiveKey: z.ZodString;
    }, z.core.$strict>>;
    acceptedAt: z.ZodISODateTime;
    finishedAt: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strict>;
export type OperationStatus = z.infer<typeof OperationStatus>;
export declare const MachineMetrics: z.ZodObject<{
    machineId: z.ZodString;
    day: z.ZodString;
    cpuSecondsUsed: z.ZodNumber;
    cpuBudgetSeconds: z.ZodLiteral<43200>;
    throttled: z.ZodBoolean;
    memoryResidentMiB: z.ZodNumber;
    diskUsedBytes: z.ZodNumber;
    egressBytesThisMonth: z.ZodNumber;
    sampledAt: z.ZodISODateTime;
}, z.core.$strict>;
export type MachineMetrics = z.infer<typeof MachineMetrics>;
/** Things the fleet did or saw on its own (an idle stop, a memory-pressure stop, a host loss). */
export declare const FleetEvent: z.ZodObject<{
    id: z.ZodString;
    machineId: z.ZodString;
    kind: z.ZodEnum<{
        state_changed: "state_changed";
        operation_finished: "operation_finished";
        budget_exhausted: "budget_exhausted";
        budget_reset: "budget_reset";
    }>;
    state: z.ZodNullable<z.ZodEnum<{
        error: "error";
        creating: "creating";
        running: "running";
        stopping: "stopping";
        stopped: "stopped";
        resuming: "resuming";
        deleting: "deleting";
        deleted: "deleted";
    }>>;
    reason: z.ZodNullable<z.ZodEnum<{
        user: "user";
        billing: "billing";
        end_of_beta: "end_of_beta";
        abuse: "abuse";
        idle: "idle";
        memory_pressure: "memory_pressure";
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
        machineId: z.ZodString;
        operation: z.ZodEnum<{
            create: "create";
            resume: "resume";
            stop: "stop";
            delete: "delete";
            bootstrap: "bootstrap";
            update_pane: "update_pane";
            prepare_to_stop: "prepare_to_stop";
            collect_diagnostics: "collect_diagnostics";
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
        result: z.ZodNullable<z.ZodObject<{
            files: z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                bytes: z.ZodNumber;
            }, z.core.$strict>>;
            archiveKey: z.ZodString;
        }, z.core.$strict>>;
        acceptedAt: z.ZodISODateTime;
        finishedAt: z.ZodNullable<z.ZodISODateTime>;
    }, z.core.$strict>>;
    getOperation: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        requestId: z.ZodUUID;
        machineId: z.ZodString;
        operation: z.ZodEnum<{
            create: "create";
            resume: "resume";
            stop: "stop";
            delete: "delete";
            bootstrap: "bootstrap";
            update_pane: "update_pane";
            prepare_to_stop: "prepare_to_stop";
            collect_diagnostics: "collect_diagnostics";
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
        result: z.ZodNullable<z.ZodObject<{
            files: z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                bytes: z.ZodNumber;
            }, z.core.$strict>>;
            archiveKey: z.ZodString;
        }, z.core.$strict>>;
        acceptedAt: z.ZodISODateTime;
        finishedAt: z.ZodNullable<z.ZodISODateTime>;
    }, z.core.$strict>>;
    getMachine: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        machineId: z.ZodString;
        state: z.ZodEnum<{
            error: "error";
            creating: "creating";
            running: "running";
            stopping: "stopping";
            stopped: "stopped";
            resuming: "resuming";
            deleting: "deleting";
            deleted: "deleted";
        }>;
        stateReason: z.ZodNullable<z.ZodEnum<{
            user: "user";
            billing: "billing";
            end_of_beta: "end_of_beta";
            abuse: "abuse";
            idle: "idle";
            memory_pressure: "memory_pressure";
            host_maintenance: "host_maintenance";
            host_lost: "host_lost";
            failed: "failed";
        }>>;
        hostId: z.ZodNullable<z.ZodString>;
        paneVersion: z.ZodNullable<z.ZodString>;
        tailnet: z.ZodObject<{
            status: z.ZodEnum<{
                awaiting_login: "awaiting_login";
                joined: "joined";
            }>;
            loginUrl: z.ZodNullable<z.ZodURL>;
            hostname: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        updatedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    getMetrics: import("./http").Route<z.ZodUndefined, z.ZodObject<{
        day: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        machineId: z.ZodString;
        day: z.ZodString;
        cpuSecondsUsed: z.ZodNumber;
        cpuBudgetSeconds: z.ZodLiteral<43200>;
        throttled: z.ZodBoolean;
        memoryResidentMiB: z.ZodNumber;
        diskUsedBytes: z.ZodNumber;
        egressBytesThisMonth: z.ZodNumber;
        sampledAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    listEvents: import("./http").Route<z.ZodUndefined, z.ZodObject<{
        after: z.ZodOptional<z.ZodString>;
        limit: z.ZodOptional<z.ZodCoercedNumber<unknown>>;
    }, z.core.$strict>, z.ZodObject<{
        events: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            machineId: z.ZodString;
            kind: z.ZodEnum<{
                state_changed: "state_changed";
                operation_finished: "operation_finished";
                budget_exhausted: "budget_exhausted";
                budget_reset: "budget_reset";
            }>;
            state: z.ZodNullable<z.ZodEnum<{
                error: "error";
                creating: "creating";
                running: "running";
                stopping: "stopping";
                stopped: "stopped";
                resuming: "resuming";
                deleting: "deleting";
                deleted: "deleted";
            }>>;
            reason: z.ZodNullable<z.ZodEnum<{
                user: "user";
                billing: "billing";
                end_of_beta: "end_of_beta";
                abuse: "abuse";
                idle: "idle";
                memory_pressure: "memory_pressure";
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
        machineId: string;
        operation: "create" | "resume" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics";
        status: "running" | "failed" | "accepted" | "succeeded";
        error: {
            code: string;
            message: string;
            next: string;
        } | null;
        result: {
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
        machineId: string;
        operation: "create" | "resume" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics";
        status: "running" | "failed" | "accepted" | "succeeded";
        error: {
            code: string;
            message: string;
            next: string;
        } | null;
        result: {
            files: {
                path: string;
                bytes: number;
            }[];
            archiveKey: string;
        } | null;
        acceptedAt: string;
        finishedAt: string | null;
    }>;
    getMachine: (machineId: string) => Promise<{
        machineId: string;
        state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted";
        stateReason: "user" | "billing" | "end_of_beta" | "abuse" | "idle" | "memory_pressure" | "host_maintenance" | "host_lost" | "failed" | null;
        hostId: string | null;
        paneVersion: string | null;
        tailnet: {
            status: "awaiting_login" | "joined";
            loginUrl: string | null;
            hostname: string | null;
        };
        updatedAt: string;
    }>;
    getMetrics: (machineId: string, day?: string) => Promise<{
        machineId: string;
        day: string;
        cpuSecondsUsed: number;
        cpuBudgetSeconds: 43200;
        throttled: boolean;
        memoryResidentMiB: number;
        diskUsedBytes: number;
        egressBytesThisMonth: number;
        sampledAt: string;
    }>;
    listEvents: (after?: string, limit?: number) => Promise<{
        events: {
            id: string;
            machineId: string;
            kind: "state_changed" | "operation_finished" | "budget_exhausted" | "budget_reset";
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted" | null;
            reason: "user" | "billing" | "end_of_beta" | "abuse" | "idle" | "memory_pressure" | "host_maintenance" | "host_lost" | "failed" | null;
            requestId: string | null;
            at: string;
        }[];
        nextCursor: string | null;
    }>;
};
export type FleetClient = ReturnType<typeof createFleetClient>;
export {};
