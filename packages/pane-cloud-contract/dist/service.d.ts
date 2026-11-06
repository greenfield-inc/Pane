/**
 * The service API: what desktop Pane's Pane Cloud adapter calls on the Pane Cloud service.
 *
 * Sign-in proves a GitHub identity and nothing more; the service keeps no GitHub token. No route
 * grants anyone access to a machine: only the machine's owner, from their own Pane, admits a
 * teammate on the host. The team directory and connection-code handoff only say whom to expect.
 */
import { z } from 'zod';
import { type ClientConfig } from './http';
/** Starts GitHub's device flow for identity only (no scopes). */
export declare const DeviceCode: z.ZodObject<{
    deviceCode: z.ZodString;
    userCode: z.ZodString;
    verificationUri: z.ZodURL;
    expiresIn: z.ZodNumber;
    interval: z.ZodNumber;
}, z.core.$strict>;
export declare const Invite: z.ZodObject<{
    id: z.ZodString;
    githubLogin: z.ZodString;
    invitedByAccountId: z.ZodString;
    status: z.ZodEnum<{
        accepted: "accepted";
        pending: "pending";
        revoked: "revoked";
    }>;
    createdAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>;
export type Invite = z.infer<typeof Invite>;
export declare const Account: z.ZodObject<{
    id: z.ZodString;
    githubId: z.ZodNumber;
    githubLogin: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    email: z.ZodNullable<z.ZodString>;
    access: z.ZodEnum<{
        invited: "invited";
        waitlisted: "waitlisted";
    }>;
    teamId: z.ZodNullable<z.ZodString>;
    role: z.ZodNullable<z.ZodEnum<{
        owner: "owner";
        member: "member";
    }>>;
    tailscaleLogin: z.ZodNullable<z.ZodString>;
    pendingInvites: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        githubLogin: z.ZodString;
        invitedByAccountId: z.ZodString;
        status: z.ZodEnum<{
            accepted: "accepted";
            pending: "pending";
            revoked: "revoked";
        }>;
        createdAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Account = z.infer<typeof Account>;
export declare const DeviceTokenResult: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"pending">;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"slow_down">;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"expired">;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"denied">;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"complete">;
    token: z.ZodString;
    expiresAt: z.ZodISODateTime;
    account: z.ZodObject<{
        id: z.ZodString;
        githubId: z.ZodNumber;
        githubLogin: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        email: z.ZodNullable<z.ZodString>;
        access: z.ZodEnum<{
            invited: "invited";
            waitlisted: "waitlisted";
        }>;
        teamId: z.ZodNullable<z.ZodString>;
        role: z.ZodNullable<z.ZodEnum<{
            owner: "owner";
            member: "member";
        }>>;
        tailscaleLogin: z.ZodNullable<z.ZodString>;
        pendingInvites: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            githubLogin: z.ZodString;
            invitedByAccountId: z.ZodString;
            status: z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                revoked: "revoked";
            }>;
            createdAt: z.ZodISODateTime;
            expiresAt: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>], "status">;
export type DeviceTokenResult = z.infer<typeof DeviceTokenResult>;
export declare const MachineState: z.ZodEnum<{
    error: "error";
    creating: "creating";
    running: "running";
    stopping: "stopping";
    stopped: "stopped";
    resuming: "resuming";
    deleting: "deleting";
    deleted: "deleted";
    suspended: "suspended";
}>;
export declare const MachineUsage: z.ZodObject<{
    day: z.ZodString;
    cpuSecondsUsed: z.ZodNumber;
    throttled: z.ZodBoolean;
    resetsAt: z.ZodISODateTime;
    egressBytesThisMonth: z.ZodNumber;
    diskUsedBytes: z.ZodNumber;
}, z.core.$strict>;
export declare const Machine: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    ownerAccountId: z.ZodString;
    state: z.ZodEnum<{
        error: "error";
        creating: "creating";
        running: "running";
        stopping: "stopping";
        stopped: "stopped";
        resuming: "resuming";
        deleting: "deleting";
        deleted: "deleted";
        suspended: "suspended";
    }>;
    stateReason: z.ZodNullable<z.ZodEnum<{
        user: "user";
        idle: "idle";
        memory_pressure: "memory_pressure";
        host_maintenance: "host_maintenance";
        host_lost: "host_lost";
        abuse: "abuse";
        billing: "billing";
        end_of_beta: "end_of_beta";
        failed: "failed";
    }>>;
    paneVersion: z.ZodNullable<z.ZodString>;
    tailnet: z.ZodObject<{
        status: z.ZodEnum<{
            awaiting_login: "awaiting_login";
            joined: "joined";
        }>;
        loginUrl: z.ZodNullable<z.ZodURL>;
        hostname: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    limits: z.ZodObject<{
        vcpu: z.ZodLiteral<8>;
        memoryMiB: z.ZodLiteral<16384>;
        diskGiB: z.ZodLiteral<50>;
        dailyCpuSeconds: z.ZodLiteral<43200>;
        monthlyEgressBytes: z.ZodLiteral<number>;
    }, z.core.$strict>;
    usage: z.ZodNullable<z.ZodObject<{
        day: z.ZodString;
        cpuSecondsUsed: z.ZodNumber;
        throttled: z.ZodBoolean;
        resetsAt: z.ZodISODateTime;
        egressBytesThisMonth: z.ZodNumber;
        diskUsedBytes: z.ZodNumber;
    }, z.core.$strict>>;
    shared: z.ZodBoolean;
    pushWindowEndsAt: z.ZodNullable<z.ZodISODateTime>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type Machine = z.infer<typeof Machine>;
/** Lifecycle actions plus the allow-listed guest operations, as the machine's action log names them. */
export declare const LoggedOperation: z.ZodEnum<{
    create: "create";
    stop: "stop";
    delete: "delete";
    bootstrap: "bootstrap";
    update_pane: "update_pane";
    prepare_to_stop: "prepare_to_stop";
    collect_diagnostics: "collect_diagnostics";
    start: "start";
}>;
export declare const ActionLogEntry: z.ZodObject<{
    id: z.ZodString;
    machineId: z.ZodString;
    operation: z.ZodEnum<{
        create: "create";
        stop: "stop";
        delete: "delete";
        bootstrap: "bootstrap";
        update_pane: "update_pane";
        prepare_to_stop: "prepare_to_stop";
        collect_diagnostics: "collect_diagnostics";
        start: "start";
    }>;
    parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    actor: z.ZodObject<{
        kind: z.ZodEnum<{
            host: "host";
            user: "user";
            service: "service";
        }>;
        accountId: z.ZodNullable<z.ZodString>;
        githubLogin: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    reason: z.ZodString;
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
    requestedAt: z.ZodISODateTime;
    finishedAt: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strict>;
export type ActionLogEntry = z.infer<typeof ActionLogEntry>;
/**
 * Operations a user may request by name. The service fills in the fixed parameters: update_pane
 * resolves `version` (default: the latest published release) to that release's checksum.
 */
export declare const UserOperationRequest: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"update_pane">;
    parameters: z.ZodObject<{
        version: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"collect_diagnostics">;
    parameters: z.ZodObject<{}, z.core.$strict>;
}, z.core.$strict>], "operation">;
export type UserOperationRequest = z.infer<typeof UserOperationRequest>;
/** Operations a user may name in requestOperation. */
export declare const USER_OPERATIONS: readonly ["update_pane", "collect_diagnostics"];
/** What requestOperation accepts before parseUserOperation checks it. */
export declare const SubmittedOperation: z.ZodObject<{
    operation: z.ZodString;
    parameters: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
}, z.core.$strict>;
export type SubmittedOperation = z.infer<typeof SubmittedOperation>;
/** Banners and email start this many days before the end date. */
export declare const BETA_NOTICE_DAYS = 30;
/** From this many days before the end date, machines start only for a push window. */
export declare const BETA_PUSH_WINDOW_DAYS = 14;
/** How long a machine runs when started inside the push-window phase. */
export declare const BETA_PUSH_WINDOW_MINUTES = 60;
/**
 * The public end of the beta, as the service tells the app. Phases follow from `endsAt` and now:
 * `open` (no date, or more than 30 days out), `notice` (banners and email), `push_windows` (no new
 * machines; a start runs for one push window) and `ended` (machines don't start; disks are deleted
 * only after Parsa approves, as a logged service action).
 */
export declare const BetaStatus: z.ZodObject<{
    endsAt: z.ZodNullable<z.ZodISODateTime>;
    noticeAt: z.ZodNullable<z.ZodISODateTime>;
    pushWindowsFrom: z.ZodNullable<z.ZodISODateTime>;
    phase: z.ZodEnum<{
        open: "open";
        notice: "notice";
        push_windows: "push_windows";
        ended: "ended";
    }>;
    pushWindowMinutes: z.ZodLiteral<60>;
    announcementUrl: z.ZodNullable<z.ZodURL>;
    ownAwsTemplateUrl: z.ZodNullable<z.ZodURL>;
}, z.core.$strict>;
export type BetaStatus = z.infer<typeof BetaStatus>;
export declare const BillingStatus: z.ZodObject<{
    teamId: z.ZodString;
    plan: z.ZodEnum<{
        cohort: "cohort";
        paid: "paid";
    }>;
    seatPriceCents: z.ZodNumber;
    currency: z.ZodLiteral<"usd">;
    foundingPriceLocked: z.ZodBoolean;
    status: z.ZodEnum<{
        free: "free";
        active: "active";
        grace: "grace";
        past_due: "past_due";
        canceled: "canceled";
    }>;
    seats: z.ZodNumber;
    chargesStartAt: z.ZodNullable<z.ZodISODateTime>;
    graceEndsAt: z.ZodNullable<z.ZodISODateTime>;
    currentPeriodEnd: z.ZodNullable<z.ZodISODateTime>;
    manageUrl: z.ZodNullable<z.ZodURL>;
}, z.core.$strict>;
export type BillingStatus = z.infer<typeof BillingStatus>;
export declare const TeamMember: z.ZodObject<{
    accountId: z.ZodString;
    githubLogin: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    role: z.ZodEnum<{
        owner: "owner";
        member: "member";
    }>;
    tailscaleLogin: z.ZodNullable<z.ZodString>;
    seat: z.ZodObject<{
        status: z.ZodEnum<{
            free: "free";
            active: "active";
            grace: "grace";
            canceled: "canceled";
        }>;
        foundingPrice: z.ZodBoolean;
    }, z.core.$strict>;
    joinedAt: z.ZodISODateTime;
}, z.core.$strict>;
export declare const Team: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    members: z.ZodArray<z.ZodObject<{
        accountId: z.ZodString;
        githubLogin: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        role: z.ZodEnum<{
            owner: "owner";
            member: "member";
        }>;
        tailscaleLogin: z.ZodNullable<z.ZodString>;
        seat: z.ZodObject<{
            status: z.ZodEnum<{
                free: "free";
                active: "active";
                grace: "grace";
                canceled: "canceled";
            }>;
            foundingPrice: z.ZodBoolean;
        }, z.core.$strict>;
        joinedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    invites: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        githubLogin: z.ZodString;
        invitedByAccountId: z.ZodString;
        status: z.ZodEnum<{
            accepted: "accepted";
            pending: "pending";
            revoked: "revoked";
        }>;
        createdAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Team = z.infer<typeof Team>;
/** One entry of the team's shared-machine directory, which Your computers → Team reads. */
export declare const SharedMachine: z.ZodObject<{
    machineId: z.ZodString;
    name: z.ZodString;
    state: z.ZodEnum<{
        error: "error";
        creating: "creating";
        running: "running";
        stopping: "stopping";
        stopped: "stopped";
        resuming: "resuming";
        deleting: "deleting";
        deleted: "deleted";
        suspended: "suspended";
    }>;
    owner: z.ZodObject<{
        accountId: z.ZodString;
        githubLogin: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        tailscaleLogin: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    tailnetHostname: z.ZodNullable<z.ZodString>;
    sharedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type SharedMachine = z.infer<typeof SharedMachine>;
/** Longest a relayed connection code may stay claimable. */
export declare const CONNECTION_CODE_MAX_SECONDS = 900;
/**
 * A named single-use connection code the owner's Pane minted on the host for one teammate, left with
 * the service for that teammate to pick up once. The host still checks the Tailscale login on the
 * request and the owner's approval; a code alone admits no one.
 */
export declare const ConnectionCodeHandoff: z.ZodObject<{
    id: z.ZodString;
    machineId: z.ZodString;
    forAccountId: z.ZodString;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>;
export declare const ClaimedConnectionCode: z.ZodObject<{
    machineId: z.ZodString;
    code: z.ZodString;
    tailnetHostname: z.ZodNullable<z.ZodString>;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>;
export declare const serviceRoutes: {
    startDeviceSignIn: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        deviceCode: z.ZodString;
        userCode: z.ZodString;
        verificationUri: z.ZodURL;
        expiresIn: z.ZodNumber;
        interval: z.ZodNumber;
    }, z.core.$strict>>;
    pollDeviceSignIn: import("./http").Route<z.ZodObject<{
        deviceCode: z.ZodString;
    }, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"pending">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"slow_down">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"expired">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"denied">;
    }, z.core.$strict>, z.ZodObject<{
        status: z.ZodLiteral<"complete">;
        token: z.ZodString;
        expiresAt: z.ZodISODateTime;
        account: z.ZodObject<{
            id: z.ZodString;
            githubId: z.ZodNumber;
            githubLogin: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            email: z.ZodNullable<z.ZodString>;
            access: z.ZodEnum<{
                invited: "invited";
                waitlisted: "waitlisted";
            }>;
            teamId: z.ZodNullable<z.ZodString>;
            role: z.ZodNullable<z.ZodEnum<{
                owner: "owner";
                member: "member";
            }>>;
            tailscaleLogin: z.ZodNullable<z.ZodString>;
            pendingInvites: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                githubLogin: z.ZodString;
                invitedByAccountId: z.ZodString;
                status: z.ZodEnum<{
                    accepted: "accepted";
                    pending: "pending";
                    revoked: "revoked";
                }>;
                createdAt: z.ZodISODateTime;
                expiresAt: z.ZodISODateTime;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strict>], "status">>;
    signOut: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        signedOut: z.ZodLiteral<true>;
    }, z.core.$strict>>;
    getAccount: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        githubId: z.ZodNumber;
        githubLogin: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        email: z.ZodNullable<z.ZodString>;
        access: z.ZodEnum<{
            invited: "invited";
            waitlisted: "waitlisted";
        }>;
        teamId: z.ZodNullable<z.ZodString>;
        role: z.ZodNullable<z.ZodEnum<{
            owner: "owner";
            member: "member";
        }>>;
        tailscaleLogin: z.ZodNullable<z.ZodString>;
        pendingInvites: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            githubLogin: z.ZodString;
            invitedByAccountId: z.ZodString;
            status: z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                revoked: "revoked";
            }>;
            createdAt: z.ZodISODateTime;
            expiresAt: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    setTailscaleLogin: import("./http").Route<z.ZodObject<{
        tailscaleLogin: z.ZodString;
    }, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        githubId: z.ZodNumber;
        githubLogin: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        email: z.ZodNullable<z.ZodString>;
        access: z.ZodEnum<{
            invited: "invited";
            waitlisted: "waitlisted";
        }>;
        teamId: z.ZodNullable<z.ZodString>;
        role: z.ZodNullable<z.ZodEnum<{
            owner: "owner";
            member: "member";
        }>>;
        tailscaleLogin: z.ZodNullable<z.ZodString>;
        pendingInvites: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            githubLogin: z.ZodString;
            invitedByAccountId: z.ZodString;
            status: z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                revoked: "revoked";
            }>;
            createdAt: z.ZodISODateTime;
            expiresAt: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    listMachines: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        machines: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            ownerAccountId: z.ZodString;
            state: z.ZodEnum<{
                error: "error";
                creating: "creating";
                running: "running";
                stopping: "stopping";
                stopped: "stopped";
                resuming: "resuming";
                deleting: "deleting";
                deleted: "deleted";
                suspended: "suspended";
            }>;
            stateReason: z.ZodNullable<z.ZodEnum<{
                user: "user";
                idle: "idle";
                memory_pressure: "memory_pressure";
                host_maintenance: "host_maintenance";
                host_lost: "host_lost";
                abuse: "abuse";
                billing: "billing";
                end_of_beta: "end_of_beta";
                failed: "failed";
            }>>;
            paneVersion: z.ZodNullable<z.ZodString>;
            tailnet: z.ZodObject<{
                status: z.ZodEnum<{
                    awaiting_login: "awaiting_login";
                    joined: "joined";
                }>;
                loginUrl: z.ZodNullable<z.ZodURL>;
                hostname: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            limits: z.ZodObject<{
                vcpu: z.ZodLiteral<8>;
                memoryMiB: z.ZodLiteral<16384>;
                diskGiB: z.ZodLiteral<50>;
                dailyCpuSeconds: z.ZodLiteral<43200>;
                monthlyEgressBytes: z.ZodLiteral<number>;
            }, z.core.$strict>;
            usage: z.ZodNullable<z.ZodObject<{
                day: z.ZodString;
                cpuSecondsUsed: z.ZodNumber;
                throttled: z.ZodBoolean;
                resetsAt: z.ZodISODateTime;
                egressBytesThisMonth: z.ZodNumber;
                diskUsedBytes: z.ZodNumber;
            }, z.core.$strict>>;
            shared: z.ZodBoolean;
            pushWindowEndsAt: z.ZodNullable<z.ZodISODateTime>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    createMachine: import("./http").Route<z.ZodObject<{
        name: z.ZodString;
        idempotencyKey: z.ZodString;
    }, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        machine: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            ownerAccountId: z.ZodString;
            state: z.ZodEnum<{
                error: "error";
                creating: "creating";
                running: "running";
                stopping: "stopping";
                stopped: "stopped";
                resuming: "resuming";
                deleting: "deleting";
                deleted: "deleted";
                suspended: "suspended";
            }>;
            stateReason: z.ZodNullable<z.ZodEnum<{
                user: "user";
                idle: "idle";
                memory_pressure: "memory_pressure";
                host_maintenance: "host_maintenance";
                host_lost: "host_lost";
                abuse: "abuse";
                billing: "billing";
                end_of_beta: "end_of_beta";
                failed: "failed";
            }>>;
            paneVersion: z.ZodNullable<z.ZodString>;
            tailnet: z.ZodObject<{
                status: z.ZodEnum<{
                    awaiting_login: "awaiting_login";
                    joined: "joined";
                }>;
                loginUrl: z.ZodNullable<z.ZodURL>;
                hostname: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            limits: z.ZodObject<{
                vcpu: z.ZodLiteral<8>;
                memoryMiB: z.ZodLiteral<16384>;
                diskGiB: z.ZodLiteral<50>;
                dailyCpuSeconds: z.ZodLiteral<43200>;
                monthlyEgressBytes: z.ZodLiteral<number>;
            }, z.core.$strict>;
            usage: z.ZodNullable<z.ZodObject<{
                day: z.ZodString;
                cpuSecondsUsed: z.ZodNumber;
                throttled: z.ZodBoolean;
                resetsAt: z.ZodISODateTime;
                egressBytesThisMonth: z.ZodNumber;
                diskUsedBytes: z.ZodNumber;
            }, z.core.$strict>>;
            shared: z.ZodBoolean;
            pushWindowEndsAt: z.ZodNullable<z.ZodISODateTime>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>;
        operation: z.ZodObject<{
            id: z.ZodString;
            machineId: z.ZodString;
            operation: z.ZodEnum<{
                create: "create";
                stop: "stop";
                delete: "delete";
                bootstrap: "bootstrap";
                update_pane: "update_pane";
                prepare_to_stop: "prepare_to_stop";
                collect_diagnostics: "collect_diagnostics";
                start: "start";
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    host: "host";
                    user: "user";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
                githubLogin: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            reason: z.ZodString;
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
            requestedAt: z.ZodISODateTime;
            finishedAt: z.ZodNullable<z.ZodISODateTime>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    getMachine: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        ownerAccountId: z.ZodString;
        state: z.ZodEnum<{
            error: "error";
            creating: "creating";
            running: "running";
            stopping: "stopping";
            stopped: "stopped";
            resuming: "resuming";
            deleting: "deleting";
            deleted: "deleted";
            suspended: "suspended";
        }>;
        stateReason: z.ZodNullable<z.ZodEnum<{
            user: "user";
            idle: "idle";
            memory_pressure: "memory_pressure";
            host_maintenance: "host_maintenance";
            host_lost: "host_lost";
            abuse: "abuse";
            billing: "billing";
            end_of_beta: "end_of_beta";
            failed: "failed";
        }>>;
        paneVersion: z.ZodNullable<z.ZodString>;
        tailnet: z.ZodObject<{
            status: z.ZodEnum<{
                awaiting_login: "awaiting_login";
                joined: "joined";
            }>;
            loginUrl: z.ZodNullable<z.ZodURL>;
            hostname: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        limits: z.ZodObject<{
            vcpu: z.ZodLiteral<8>;
            memoryMiB: z.ZodLiteral<16384>;
            diskGiB: z.ZodLiteral<50>;
            dailyCpuSeconds: z.ZodLiteral<43200>;
            monthlyEgressBytes: z.ZodLiteral<number>;
        }, z.core.$strict>;
        usage: z.ZodNullable<z.ZodObject<{
            day: z.ZodString;
            cpuSecondsUsed: z.ZodNumber;
            throttled: z.ZodBoolean;
            resetsAt: z.ZodISODateTime;
            egressBytesThisMonth: z.ZodNumber;
            diskUsedBytes: z.ZodNumber;
        }, z.core.$strict>>;
        shared: z.ZodBoolean;
        pushWindowEndsAt: z.ZodNullable<z.ZodISODateTime>;
        createdAt: z.ZodISODateTime;
        updatedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    startMachine: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        machine: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            ownerAccountId: z.ZodString;
            state: z.ZodEnum<{
                error: "error";
                creating: "creating";
                running: "running";
                stopping: "stopping";
                stopped: "stopped";
                resuming: "resuming";
                deleting: "deleting";
                deleted: "deleted";
                suspended: "suspended";
            }>;
            stateReason: z.ZodNullable<z.ZodEnum<{
                user: "user";
                idle: "idle";
                memory_pressure: "memory_pressure";
                host_maintenance: "host_maintenance";
                host_lost: "host_lost";
                abuse: "abuse";
                billing: "billing";
                end_of_beta: "end_of_beta";
                failed: "failed";
            }>>;
            paneVersion: z.ZodNullable<z.ZodString>;
            tailnet: z.ZodObject<{
                status: z.ZodEnum<{
                    awaiting_login: "awaiting_login";
                    joined: "joined";
                }>;
                loginUrl: z.ZodNullable<z.ZodURL>;
                hostname: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            limits: z.ZodObject<{
                vcpu: z.ZodLiteral<8>;
                memoryMiB: z.ZodLiteral<16384>;
                diskGiB: z.ZodLiteral<50>;
                dailyCpuSeconds: z.ZodLiteral<43200>;
                monthlyEgressBytes: z.ZodLiteral<number>;
            }, z.core.$strict>;
            usage: z.ZodNullable<z.ZodObject<{
                day: z.ZodString;
                cpuSecondsUsed: z.ZodNumber;
                throttled: z.ZodBoolean;
                resetsAt: z.ZodISODateTime;
                egressBytesThisMonth: z.ZodNumber;
                diskUsedBytes: z.ZodNumber;
            }, z.core.$strict>>;
            shared: z.ZodBoolean;
            pushWindowEndsAt: z.ZodNullable<z.ZodISODateTime>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>;
        operation: z.ZodObject<{
            id: z.ZodString;
            machineId: z.ZodString;
            operation: z.ZodEnum<{
                create: "create";
                stop: "stop";
                delete: "delete";
                bootstrap: "bootstrap";
                update_pane: "update_pane";
                prepare_to_stop: "prepare_to_stop";
                collect_diagnostics: "collect_diagnostics";
                start: "start";
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    host: "host";
                    user: "user";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
                githubLogin: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            reason: z.ZodString;
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
            requestedAt: z.ZodISODateTime;
            finishedAt: z.ZodNullable<z.ZodISODateTime>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    stopMachine: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        machine: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            ownerAccountId: z.ZodString;
            state: z.ZodEnum<{
                error: "error";
                creating: "creating";
                running: "running";
                stopping: "stopping";
                stopped: "stopped";
                resuming: "resuming";
                deleting: "deleting";
                deleted: "deleted";
                suspended: "suspended";
            }>;
            stateReason: z.ZodNullable<z.ZodEnum<{
                user: "user";
                idle: "idle";
                memory_pressure: "memory_pressure";
                host_maintenance: "host_maintenance";
                host_lost: "host_lost";
                abuse: "abuse";
                billing: "billing";
                end_of_beta: "end_of_beta";
                failed: "failed";
            }>>;
            paneVersion: z.ZodNullable<z.ZodString>;
            tailnet: z.ZodObject<{
                status: z.ZodEnum<{
                    awaiting_login: "awaiting_login";
                    joined: "joined";
                }>;
                loginUrl: z.ZodNullable<z.ZodURL>;
                hostname: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            limits: z.ZodObject<{
                vcpu: z.ZodLiteral<8>;
                memoryMiB: z.ZodLiteral<16384>;
                diskGiB: z.ZodLiteral<50>;
                dailyCpuSeconds: z.ZodLiteral<43200>;
                monthlyEgressBytes: z.ZodLiteral<number>;
            }, z.core.$strict>;
            usage: z.ZodNullable<z.ZodObject<{
                day: z.ZodString;
                cpuSecondsUsed: z.ZodNumber;
                throttled: z.ZodBoolean;
                resetsAt: z.ZodISODateTime;
                egressBytesThisMonth: z.ZodNumber;
                diskUsedBytes: z.ZodNumber;
            }, z.core.$strict>>;
            shared: z.ZodBoolean;
            pushWindowEndsAt: z.ZodNullable<z.ZodISODateTime>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>;
        operation: z.ZodObject<{
            id: z.ZodString;
            machineId: z.ZodString;
            operation: z.ZodEnum<{
                create: "create";
                stop: "stop";
                delete: "delete";
                bootstrap: "bootstrap";
                update_pane: "update_pane";
                prepare_to_stop: "prepare_to_stop";
                collect_diagnostics: "collect_diagnostics";
                start: "start";
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    host: "host";
                    user: "user";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
                githubLogin: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            reason: z.ZodString;
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
            requestedAt: z.ZodISODateTime;
            finishedAt: z.ZodNullable<z.ZodISODateTime>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    deleteMachine: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        machine: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            ownerAccountId: z.ZodString;
            state: z.ZodEnum<{
                error: "error";
                creating: "creating";
                running: "running";
                stopping: "stopping";
                stopped: "stopped";
                resuming: "resuming";
                deleting: "deleting";
                deleted: "deleted";
                suspended: "suspended";
            }>;
            stateReason: z.ZodNullable<z.ZodEnum<{
                user: "user";
                idle: "idle";
                memory_pressure: "memory_pressure";
                host_maintenance: "host_maintenance";
                host_lost: "host_lost";
                abuse: "abuse";
                billing: "billing";
                end_of_beta: "end_of_beta";
                failed: "failed";
            }>>;
            paneVersion: z.ZodNullable<z.ZodString>;
            tailnet: z.ZodObject<{
                status: z.ZodEnum<{
                    awaiting_login: "awaiting_login";
                    joined: "joined";
                }>;
                loginUrl: z.ZodNullable<z.ZodURL>;
                hostname: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            limits: z.ZodObject<{
                vcpu: z.ZodLiteral<8>;
                memoryMiB: z.ZodLiteral<16384>;
                diskGiB: z.ZodLiteral<50>;
                dailyCpuSeconds: z.ZodLiteral<43200>;
                monthlyEgressBytes: z.ZodLiteral<number>;
            }, z.core.$strict>;
            usage: z.ZodNullable<z.ZodObject<{
                day: z.ZodString;
                cpuSecondsUsed: z.ZodNumber;
                throttled: z.ZodBoolean;
                resetsAt: z.ZodISODateTime;
                egressBytesThisMonth: z.ZodNumber;
                diskUsedBytes: z.ZodNumber;
            }, z.core.$strict>>;
            shared: z.ZodBoolean;
            pushWindowEndsAt: z.ZodNullable<z.ZodISODateTime>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>;
        operation: z.ZodObject<{
            id: z.ZodString;
            machineId: z.ZodString;
            operation: z.ZodEnum<{
                create: "create";
                stop: "stop";
                delete: "delete";
                bootstrap: "bootstrap";
                update_pane: "update_pane";
                prepare_to_stop: "prepare_to_stop";
                collect_diagnostics: "collect_diagnostics";
                start: "start";
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    host: "host";
                    user: "user";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
                githubLogin: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            reason: z.ZodString;
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
            requestedAt: z.ZodISODateTime;
            finishedAt: z.ZodNullable<z.ZodISODateTime>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    requestOperation: import("./http").Route<z.ZodObject<{
        operation: z.ZodString;
        parameters: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        machineId: z.ZodString;
        operation: z.ZodEnum<{
            create: "create";
            stop: "stop";
            delete: "delete";
            bootstrap: "bootstrap";
            update_pane: "update_pane";
            prepare_to_stop: "prepare_to_stop";
            collect_diagnostics: "collect_diagnostics";
            start: "start";
        }>;
        parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        actor: z.ZodObject<{
            kind: z.ZodEnum<{
                host: "host";
                user: "user";
                service: "service";
            }>;
            accountId: z.ZodNullable<z.ZodString>;
            githubLogin: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        reason: z.ZodString;
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
        requestedAt: z.ZodISODateTime;
        finishedAt: z.ZodNullable<z.ZodISODateTime>;
    }, z.core.$strict>>;
    listActionLog: import("./http").Route<z.ZodUndefined, z.ZodObject<{
        before: z.ZodOptional<z.ZodString>;
        limit: z.ZodOptional<z.ZodCoercedNumber<unknown>>;
    }, z.core.$strict>, z.ZodObject<{
        entries: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            machineId: z.ZodString;
            operation: z.ZodEnum<{
                create: "create";
                stop: "stop";
                delete: "delete";
                bootstrap: "bootstrap";
                update_pane: "update_pane";
                prepare_to_stop: "prepare_to_stop";
                collect_diagnostics: "collect_diagnostics";
                start: "start";
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    host: "host";
                    user: "user";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
                githubLogin: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            reason: z.ZodString;
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
            requestedAt: z.ZodISODateTime;
            finishedAt: z.ZodNullable<z.ZodISODateTime>;
        }, z.core.$strict>>;
        nextCursor: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    setSharing: import("./http").Route<z.ZodObject<{
        shared: z.ZodBoolean;
    }, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        ownerAccountId: z.ZodString;
        state: z.ZodEnum<{
            error: "error";
            creating: "creating";
            running: "running";
            stopping: "stopping";
            stopped: "stopped";
            resuming: "resuming";
            deleting: "deleting";
            deleted: "deleted";
            suspended: "suspended";
        }>;
        stateReason: z.ZodNullable<z.ZodEnum<{
            user: "user";
            idle: "idle";
            memory_pressure: "memory_pressure";
            host_maintenance: "host_maintenance";
            host_lost: "host_lost";
            abuse: "abuse";
            billing: "billing";
            end_of_beta: "end_of_beta";
            failed: "failed";
        }>>;
        paneVersion: z.ZodNullable<z.ZodString>;
        tailnet: z.ZodObject<{
            status: z.ZodEnum<{
                awaiting_login: "awaiting_login";
                joined: "joined";
            }>;
            loginUrl: z.ZodNullable<z.ZodURL>;
            hostname: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        limits: z.ZodObject<{
            vcpu: z.ZodLiteral<8>;
            memoryMiB: z.ZodLiteral<16384>;
            diskGiB: z.ZodLiteral<50>;
            dailyCpuSeconds: z.ZodLiteral<43200>;
            monthlyEgressBytes: z.ZodLiteral<number>;
        }, z.core.$strict>;
        usage: z.ZodNullable<z.ZodObject<{
            day: z.ZodString;
            cpuSecondsUsed: z.ZodNumber;
            throttled: z.ZodBoolean;
            resetsAt: z.ZodISODateTime;
            egressBytesThisMonth: z.ZodNumber;
            diskUsedBytes: z.ZodNumber;
        }, z.core.$strict>>;
        shared: z.ZodBoolean;
        pushWindowEndsAt: z.ZodNullable<z.ZodISODateTime>;
        createdAt: z.ZodISODateTime;
        updatedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    leaveConnectionCode: import("./http").Route<z.ZodObject<{
        forAccountId: z.ZodString;
        code: z.ZodString;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        machineId: z.ZodString;
        forAccountId: z.ZodString;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    claimConnectionCode: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        machineId: z.ZodString;
        code: z.ZodString;
        tailnetHostname: z.ZodNullable<z.ZodString>;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    getBeta: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        endsAt: z.ZodNullable<z.ZodISODateTime>;
        noticeAt: z.ZodNullable<z.ZodISODateTime>;
        pushWindowsFrom: z.ZodNullable<z.ZodISODateTime>;
        phase: z.ZodEnum<{
            open: "open";
            notice: "notice";
            push_windows: "push_windows";
            ended: "ended";
        }>;
        pushWindowMinutes: z.ZodLiteral<60>;
        announcementUrl: z.ZodNullable<z.ZodURL>;
        ownAwsTemplateUrl: z.ZodNullable<z.ZodURL>;
    }, z.core.$strict>>;
    getBilling: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        teamId: z.ZodString;
        plan: z.ZodEnum<{
            cohort: "cohort";
            paid: "paid";
        }>;
        seatPriceCents: z.ZodNumber;
        currency: z.ZodLiteral<"usd">;
        foundingPriceLocked: z.ZodBoolean;
        status: z.ZodEnum<{
            free: "free";
            active: "active";
            grace: "grace";
            past_due: "past_due";
            canceled: "canceled";
        }>;
        seats: z.ZodNumber;
        chargesStartAt: z.ZodNullable<z.ZodISODateTime>;
        graceEndsAt: z.ZodNullable<z.ZodISODateTime>;
        currentPeriodEnd: z.ZodNullable<z.ZodISODateTime>;
        manageUrl: z.ZodNullable<z.ZodURL>;
    }, z.core.$strict>>;
    getTeam: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        members: z.ZodArray<z.ZodObject<{
            accountId: z.ZodString;
            githubLogin: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            role: z.ZodEnum<{
                owner: "owner";
                member: "member";
            }>;
            tailscaleLogin: z.ZodNullable<z.ZodString>;
            seat: z.ZodObject<{
                status: z.ZodEnum<{
                    free: "free";
                    active: "active";
                    grace: "grace";
                    canceled: "canceled";
                }>;
                foundingPrice: z.ZodBoolean;
            }, z.core.$strict>;
            joinedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
        invites: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            githubLogin: z.ZodString;
            invitedByAccountId: z.ZodString;
            status: z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                revoked: "revoked";
            }>;
            createdAt: z.ZodISODateTime;
            expiresAt: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    createInvite: import("./http").Route<z.ZodObject<{
        githubLogin: z.ZodString;
    }, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        githubLogin: z.ZodString;
        invitedByAccountId: z.ZodString;
        status: z.ZodEnum<{
            accepted: "accepted";
            pending: "pending";
            revoked: "revoked";
        }>;
        createdAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    revokeInvite: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        githubLogin: z.ZodString;
        invitedByAccountId: z.ZodString;
        status: z.ZodEnum<{
            accepted: "accepted";
            pending: "pending";
            revoked: "revoked";
        }>;
        createdAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    acceptInvite: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        githubId: z.ZodNumber;
        githubLogin: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        email: z.ZodNullable<z.ZodString>;
        access: z.ZodEnum<{
            invited: "invited";
            waitlisted: "waitlisted";
        }>;
        teamId: z.ZodNullable<z.ZodString>;
        role: z.ZodNullable<z.ZodEnum<{
            owner: "owner";
            member: "member";
        }>>;
        tailscaleLogin: z.ZodNullable<z.ZodString>;
        pendingInvites: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            githubLogin: z.ZodString;
            invitedByAccountId: z.ZodString;
            status: z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                revoked: "revoked";
            }>;
            createdAt: z.ZodISODateTime;
            expiresAt: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    removeMember: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        members: z.ZodArray<z.ZodObject<{
            accountId: z.ZodString;
            githubLogin: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            role: z.ZodEnum<{
                owner: "owner";
                member: "member";
            }>;
            tailscaleLogin: z.ZodNullable<z.ZodString>;
            seat: z.ZodObject<{
                status: z.ZodEnum<{
                    free: "free";
                    active: "active";
                    grace: "grace";
                    canceled: "canceled";
                }>;
                foundingPrice: z.ZodBoolean;
            }, z.core.$strict>;
            joinedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
        invites: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            githubLogin: z.ZodString;
            invitedByAccountId: z.ZodString;
            status: z.ZodEnum<{
                accepted: "accepted";
                pending: "pending";
                revoked: "revoked";
            }>;
            createdAt: z.ZodISODateTime;
            expiresAt: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    listSharedMachines: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        machines: z.ZodArray<z.ZodObject<{
            machineId: z.ZodString;
            name: z.ZodString;
            state: z.ZodEnum<{
                error: "error";
                creating: "creating";
                running: "running";
                stopping: "stopping";
                stopped: "stopped";
                resuming: "resuming";
                deleting: "deleting";
                deleted: "deleted";
                suspended: "suspended";
            }>;
            owner: z.ZodObject<{
                accountId: z.ZodString;
                githubLogin: z.ZodString;
                name: z.ZodNullable<z.ZodString>;
                tailscaleLogin: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            tailnetHostname: z.ZodNullable<z.ZodString>;
            sharedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
};
/** The desktop adapter's client for the service API. */
export declare function createServiceClient(config: ClientConfig): {
    startDeviceSignIn: () => Promise<{
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        expiresIn: number;
        interval: number;
    }>;
    pollDeviceSignIn: (deviceCode: string) => Promise<{
        status: "pending";
    } | {
        status: "slow_down";
    } | {
        status: "expired";
    } | {
        status: "denied";
    } | {
        status: "complete";
        token: string;
        expiresAt: string;
        account: {
            id: string;
            githubId: number;
            githubLogin: string;
            name: string | null;
            email: string | null;
            access: "invited" | "waitlisted";
            teamId: string | null;
            role: "owner" | "member" | null;
            tailscaleLogin: string | null;
            pendingInvites: {
                id: string;
                githubLogin: string;
                invitedByAccountId: string;
                status: "accepted" | "pending" | "revoked";
                createdAt: string;
                expiresAt: string;
            }[];
        };
    }>;
    signOut: () => Promise<{
        signedOut: true;
    }>;
    getAccount: () => Promise<{
        id: string;
        githubId: number;
        githubLogin: string;
        name: string | null;
        email: string | null;
        access: "invited" | "waitlisted";
        teamId: string | null;
        role: "owner" | "member" | null;
        tailscaleLogin: string | null;
        pendingInvites: {
            id: string;
            githubLogin: string;
            invitedByAccountId: string;
            status: "accepted" | "pending" | "revoked";
            createdAt: string;
            expiresAt: string;
        }[];
    }>;
    setTailscaleLogin: (tailscaleLogin: string) => Promise<{
        id: string;
        githubId: number;
        githubLogin: string;
        name: string | null;
        email: string | null;
        access: "invited" | "waitlisted";
        teamId: string | null;
        role: "owner" | "member" | null;
        tailscaleLogin: string | null;
        pendingInvites: {
            id: string;
            githubLogin: string;
            invitedByAccountId: string;
            status: "accepted" | "pending" | "revoked";
            createdAt: string;
            expiresAt: string;
        }[];
    }>;
    listMachines: () => Promise<{
        machines: {
            id: string;
            name: string;
            ownerAccountId: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted" | "suspended";
            stateReason: "user" | "idle" | "memory_pressure" | "host_maintenance" | "host_lost" | "abuse" | "billing" | "end_of_beta" | "failed" | null;
            paneVersion: string | null;
            tailnet: {
                status: "awaiting_login" | "joined";
                loginUrl: string | null;
                hostname: string | null;
            };
            limits: {
                vcpu: 8;
                memoryMiB: 16384;
                diskGiB: 50;
                dailyCpuSeconds: 43200;
                monthlyEgressBytes: number;
            };
            usage: {
                day: string;
                cpuSecondsUsed: number;
                throttled: boolean;
                resetsAt: string;
                egressBytesThisMonth: number;
                diskUsedBytes: number;
            } | null;
            shared: boolean;
            pushWindowEndsAt: string | null;
            createdAt: string;
            updatedAt: string;
        }[];
    }>;
    createMachine: (name: string, idempotencyKey: string) => Promise<{
        machine: {
            id: string;
            name: string;
            ownerAccountId: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted" | "suspended";
            stateReason: "user" | "idle" | "memory_pressure" | "host_maintenance" | "host_lost" | "abuse" | "billing" | "end_of_beta" | "failed" | null;
            paneVersion: string | null;
            tailnet: {
                status: "awaiting_login" | "joined";
                loginUrl: string | null;
                hostname: string | null;
            };
            limits: {
                vcpu: 8;
                memoryMiB: 16384;
                diskGiB: 50;
                dailyCpuSeconds: 43200;
                monthlyEgressBytes: number;
            };
            usage: {
                day: string;
                cpuSecondsUsed: number;
                throttled: boolean;
                resetsAt: string;
                egressBytesThisMonth: number;
                diskUsedBytes: number;
            } | null;
            shared: boolean;
            pushWindowEndsAt: string | null;
            createdAt: string;
            updatedAt: string;
        };
        operation: {
            id: string;
            machineId: string;
            operation: "create" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "start";
            parameters: Record<string, unknown>;
            actor: {
                kind: "host" | "user" | "service";
                accountId: string | null;
                githubLogin: string | null;
            };
            reason: string;
            status: "running" | "failed" | "accepted" | "succeeded";
            error: {
                code: string;
                message: string;
                next: string;
            } | null;
            requestedAt: string;
            finishedAt: string | null;
        };
    }>;
    getMachine: (machineId: string) => Promise<{
        id: string;
        name: string;
        ownerAccountId: string;
        state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted" | "suspended";
        stateReason: "user" | "idle" | "memory_pressure" | "host_maintenance" | "host_lost" | "abuse" | "billing" | "end_of_beta" | "failed" | null;
        paneVersion: string | null;
        tailnet: {
            status: "awaiting_login" | "joined";
            loginUrl: string | null;
            hostname: string | null;
        };
        limits: {
            vcpu: 8;
            memoryMiB: 16384;
            diskGiB: 50;
            dailyCpuSeconds: 43200;
            monthlyEgressBytes: number;
        };
        usage: {
            day: string;
            cpuSecondsUsed: number;
            throttled: boolean;
            resetsAt: string;
            egressBytesThisMonth: number;
            diskUsedBytes: number;
        } | null;
        shared: boolean;
        pushWindowEndsAt: string | null;
        createdAt: string;
        updatedAt: string;
    }>;
    startMachine: (machineId: string) => Promise<{
        machine: {
            id: string;
            name: string;
            ownerAccountId: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted" | "suspended";
            stateReason: "user" | "idle" | "memory_pressure" | "host_maintenance" | "host_lost" | "abuse" | "billing" | "end_of_beta" | "failed" | null;
            paneVersion: string | null;
            tailnet: {
                status: "awaiting_login" | "joined";
                loginUrl: string | null;
                hostname: string | null;
            };
            limits: {
                vcpu: 8;
                memoryMiB: 16384;
                diskGiB: 50;
                dailyCpuSeconds: 43200;
                monthlyEgressBytes: number;
            };
            usage: {
                day: string;
                cpuSecondsUsed: number;
                throttled: boolean;
                resetsAt: string;
                egressBytesThisMonth: number;
                diskUsedBytes: number;
            } | null;
            shared: boolean;
            pushWindowEndsAt: string | null;
            createdAt: string;
            updatedAt: string;
        };
        operation: {
            id: string;
            machineId: string;
            operation: "create" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "start";
            parameters: Record<string, unknown>;
            actor: {
                kind: "host" | "user" | "service";
                accountId: string | null;
                githubLogin: string | null;
            };
            reason: string;
            status: "running" | "failed" | "accepted" | "succeeded";
            error: {
                code: string;
                message: string;
                next: string;
            } | null;
            requestedAt: string;
            finishedAt: string | null;
        };
    }>;
    stopMachine: (machineId: string) => Promise<{
        machine: {
            id: string;
            name: string;
            ownerAccountId: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted" | "suspended";
            stateReason: "user" | "idle" | "memory_pressure" | "host_maintenance" | "host_lost" | "abuse" | "billing" | "end_of_beta" | "failed" | null;
            paneVersion: string | null;
            tailnet: {
                status: "awaiting_login" | "joined";
                loginUrl: string | null;
                hostname: string | null;
            };
            limits: {
                vcpu: 8;
                memoryMiB: 16384;
                diskGiB: 50;
                dailyCpuSeconds: 43200;
                monthlyEgressBytes: number;
            };
            usage: {
                day: string;
                cpuSecondsUsed: number;
                throttled: boolean;
                resetsAt: string;
                egressBytesThisMonth: number;
                diskUsedBytes: number;
            } | null;
            shared: boolean;
            pushWindowEndsAt: string | null;
            createdAt: string;
            updatedAt: string;
        };
        operation: {
            id: string;
            machineId: string;
            operation: "create" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "start";
            parameters: Record<string, unknown>;
            actor: {
                kind: "host" | "user" | "service";
                accountId: string | null;
                githubLogin: string | null;
            };
            reason: string;
            status: "running" | "failed" | "accepted" | "succeeded";
            error: {
                code: string;
                message: string;
                next: string;
            } | null;
            requestedAt: string;
            finishedAt: string | null;
        };
    }>;
    deleteMachine: (machineId: string) => Promise<{
        machine: {
            id: string;
            name: string;
            ownerAccountId: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted" | "suspended";
            stateReason: "user" | "idle" | "memory_pressure" | "host_maintenance" | "host_lost" | "abuse" | "billing" | "end_of_beta" | "failed" | null;
            paneVersion: string | null;
            tailnet: {
                status: "awaiting_login" | "joined";
                loginUrl: string | null;
                hostname: string | null;
            };
            limits: {
                vcpu: 8;
                memoryMiB: 16384;
                diskGiB: 50;
                dailyCpuSeconds: 43200;
                monthlyEgressBytes: number;
            };
            usage: {
                day: string;
                cpuSecondsUsed: number;
                throttled: boolean;
                resetsAt: string;
                egressBytesThisMonth: number;
                diskUsedBytes: number;
            } | null;
            shared: boolean;
            pushWindowEndsAt: string | null;
            createdAt: string;
            updatedAt: string;
        };
        operation: {
            id: string;
            machineId: string;
            operation: "create" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "start";
            parameters: Record<string, unknown>;
            actor: {
                kind: "host" | "user" | "service";
                accountId: string | null;
                githubLogin: string | null;
            };
            reason: string;
            status: "running" | "failed" | "accepted" | "succeeded";
            error: {
                code: string;
                message: string;
                next: string;
            } | null;
            requestedAt: string;
            finishedAt: string | null;
        };
    }>;
    requestOperation: (machineId: string, request: UserOperationRequest) => Promise<{
        id: string;
        machineId: string;
        operation: "create" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "start";
        parameters: Record<string, unknown>;
        actor: {
            kind: "host" | "user" | "service";
            accountId: string | null;
            githubLogin: string | null;
        };
        reason: string;
        status: "running" | "failed" | "accepted" | "succeeded";
        error: {
            code: string;
            message: string;
            next: string;
        } | null;
        requestedAt: string;
        finishedAt: string | null;
    }>;
    listActionLog: (machineId: string, page?: {
        before?: string;
        limit?: number;
    }) => Promise<{
        entries: {
            id: string;
            machineId: string;
            operation: "create" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics" | "start";
            parameters: Record<string, unknown>;
            actor: {
                kind: "host" | "user" | "service";
                accountId: string | null;
                githubLogin: string | null;
            };
            reason: string;
            status: "running" | "failed" | "accepted" | "succeeded";
            error: {
                code: string;
                message: string;
                next: string;
            } | null;
            requestedAt: string;
            finishedAt: string | null;
        }[];
        nextCursor: string | null;
    }>;
    setSharing: (machineId: string, shared: boolean) => Promise<{
        id: string;
        name: string;
        ownerAccountId: string;
        state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted" | "suspended";
        stateReason: "user" | "idle" | "memory_pressure" | "host_maintenance" | "host_lost" | "abuse" | "billing" | "end_of_beta" | "failed" | null;
        paneVersion: string | null;
        tailnet: {
            status: "awaiting_login" | "joined";
            loginUrl: string | null;
            hostname: string | null;
        };
        limits: {
            vcpu: 8;
            memoryMiB: 16384;
            diskGiB: 50;
            dailyCpuSeconds: 43200;
            monthlyEgressBytes: number;
        };
        usage: {
            day: string;
            cpuSecondsUsed: number;
            throttled: boolean;
            resetsAt: string;
            egressBytesThisMonth: number;
            diskUsedBytes: number;
        } | null;
        shared: boolean;
        pushWindowEndsAt: string | null;
        createdAt: string;
        updatedAt: string;
    }>;
    leaveConnectionCode: (machineId: string, handoff: {
        forAccountId: string;
        code: string;
        expiresAt: string;
    }) => Promise<{
        id: string;
        machineId: string;
        forAccountId: string;
        expiresAt: string;
    }>;
    claimConnectionCode: (machineId: string) => Promise<{
        machineId: string;
        code: string;
        tailnetHostname: string | null;
        expiresAt: string;
    }>;
    getBeta: () => Promise<{
        endsAt: string | null;
        noticeAt: string | null;
        pushWindowsFrom: string | null;
        phase: "open" | "notice" | "push_windows" | "ended";
        pushWindowMinutes: 60;
        announcementUrl: string | null;
        ownAwsTemplateUrl: string | null;
    }>;
    getBilling: () => Promise<{
        teamId: string;
        plan: "cohort" | "paid";
        seatPriceCents: number;
        currency: "usd";
        foundingPriceLocked: boolean;
        status: "free" | "active" | "grace" | "past_due" | "canceled";
        seats: number;
        chargesStartAt: string | null;
        graceEndsAt: string | null;
        currentPeriodEnd: string | null;
        manageUrl: string | null;
    }>;
    getTeam: () => Promise<{
        id: string;
        name: string;
        members: {
            accountId: string;
            githubLogin: string;
            name: string | null;
            role: "owner" | "member";
            tailscaleLogin: string | null;
            seat: {
                status: "free" | "active" | "grace" | "canceled";
                foundingPrice: boolean;
            };
            joinedAt: string;
        }[];
        invites: {
            id: string;
            githubLogin: string;
            invitedByAccountId: string;
            status: "accepted" | "pending" | "revoked";
            createdAt: string;
            expiresAt: string;
        }[];
    }>;
    createInvite: (githubLogin: string) => Promise<{
        id: string;
        githubLogin: string;
        invitedByAccountId: string;
        status: "accepted" | "pending" | "revoked";
        createdAt: string;
        expiresAt: string;
    }>;
    revokeInvite: (inviteId: string) => Promise<{
        id: string;
        githubLogin: string;
        invitedByAccountId: string;
        status: "accepted" | "pending" | "revoked";
        createdAt: string;
        expiresAt: string;
    }>;
    acceptInvite: (inviteId: string) => Promise<{
        id: string;
        githubId: number;
        githubLogin: string;
        name: string | null;
        email: string | null;
        access: "invited" | "waitlisted";
        teamId: string | null;
        role: "owner" | "member" | null;
        tailscaleLogin: string | null;
        pendingInvites: {
            id: string;
            githubLogin: string;
            invitedByAccountId: string;
            status: "accepted" | "pending" | "revoked";
            createdAt: string;
            expiresAt: string;
        }[];
    }>;
    removeMember: (accountId: string) => Promise<{
        id: string;
        name: string;
        members: {
            accountId: string;
            githubLogin: string;
            name: string | null;
            role: "owner" | "member";
            tailscaleLogin: string | null;
            seat: {
                status: "free" | "active" | "grace" | "canceled";
                foundingPrice: boolean;
            };
            joinedAt: string;
        }[];
        invites: {
            id: string;
            githubLogin: string;
            invitedByAccountId: string;
            status: "accepted" | "pending" | "revoked";
            createdAt: string;
            expiresAt: string;
        }[];
    }>;
    listSharedMachines: () => Promise<{
        machines: {
            machineId: string;
            name: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "resuming" | "deleting" | "deleted" | "suspended";
            owner: {
                accountId: string;
                githubLogin: string;
                name: string | null;
                tailscaleLogin: string | null;
            };
            tailnetHostname: string | null;
            sharedAt: string;
        }[];
    }>;
};
export type ServiceClient = ReturnType<typeof createServiceClient>;
/**
 * The service's allow-list check for a user's operation request: operation_not_allowed for any name
 * outside USER_OPERATIONS, invalid_request for parameters outside that operation's fixed schema.
 */
export declare function parseUserOperation(body: SubmittedOperation): UserOperationRequest;
