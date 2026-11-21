/**
 * The service API: what Pane (desktop, phone, runpane) calls on the Pane Cloud service.
 *
 * Every account belongs to organizations; a Session VM belongs to the organization it was created in
 * and answers only the member who created it. The service changes a VM only through signed fleet
 * operations, and logs each one in the VM's action log.
 */
import { z } from 'zod';
import { type ClientConfig } from './http';
/**
 * The three plans. Hours are per Full access member a month, pooled across the organization; the
 * awake limit is per Full access member. Prices live with billing, not here.
 */
export declare const PLANS: {
    readonly free: {
        readonly agentHoursPerMember: 300;
        readonly awakeLimitPerMember: 5;
    };
    readonly pro: {
        readonly agentHoursPerMember: 1500;
        readonly awakeLimitPerMember: 20;
    };
    readonly max: {
        readonly agentHoursPerMember: 3000;
        readonly awakeLimitPerMember: 50;
    };
};
export declare const Plan: z.ZodEnum<{
    free: "free";
    pro: "pro";
    max: "max";
}>;
export type Plan = z.infer<typeof Plan>;
/** Agent-hours one awake hour counts, by the VM's memory: an hour at 16 GiB counts as 2. */
export declare const AGENT_HOURS_PER_AWAKE_HOUR: {
    readonly 8: 1;
    readonly 16: 2;
};
/**
 * Device sign-in: Pane opens `verificationUriComplete` in the system browser, the person signs in
 * there (Google or GitHub), and Pane polls with `deviceCode` until it completes.
 */
export declare const DeviceCode: z.ZodObject<{
    deviceCode: z.ZodString;
    userCode: z.ZodString;
    verificationUri: z.ZodURL;
    verificationUriComplete: z.ZodURL;
    expiresIn: z.ZodNumber;
    interval: z.ZodNumber;
}, z.core.$strict>;
/** `full_access` members open, type into and create Sessions; `view_only` members read shared ones. */
export declare const OrgRole: z.ZodEnum<{
    owner: "owner";
    full_access: "full_access";
    view_only: "view_only";
}>;
export declare const Membership: z.ZodObject<{
    organizationId: z.ZodString;
    name: z.ZodString;
    personal: z.ZodBoolean;
    role: z.ZodEnum<{
        owner: "owner";
        full_access: "full_access";
        view_only: "view_only";
    }>;
}, z.core.$strict>;
export declare const Account: z.ZodObject<{
    id: z.ZodString;
    email: z.ZodEmail;
    name: z.ZodNullable<z.ZodString>;
    access: z.ZodEnum<{
        invited: "invited";
        waitlisted: "waitlisted";
    }>;
    signupState: z.ZodEnum<{
        needs_phone: "needs_phone";
        needs_card: "needs_card";
        ready: "ready";
    }>;
    organizations: z.ZodArray<z.ZodObject<{
        organizationId: z.ZodString;
        name: z.ZodString;
        personal: z.ZodBoolean;
        role: z.ZodEnum<{
            owner: "owner";
            full_access: "full_access";
            view_only: "view_only";
        }>;
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
        email: z.ZodEmail;
        name: z.ZodNullable<z.ZodString>;
        access: z.ZodEnum<{
            invited: "invited";
            waitlisted: "waitlisted";
        }>;
        signupState: z.ZodEnum<{
            needs_phone: "needs_phone";
            needs_card: "needs_card";
            ready: "ready";
        }>;
        organizations: z.ZodArray<z.ZodObject<{
            organizationId: z.ZodString;
            name: z.ZodString;
            personal: z.ZodBoolean;
            role: z.ZodEnum<{
                owner: "owner";
                full_access: "full_access";
                view_only: "view_only";
            }>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>], "status">;
export type DeviceTokenResult = z.infer<typeof DeviceTokenResult>;
export declare const SessionVm: z.ZodObject<{
    id: z.ZodString;
    organizationId: z.ZodString;
    createdByAccountId: z.ZodString;
    name: z.ZodString;
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
    memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
    paneVersion: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodISODateTime;
    updatedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type SessionVm = z.infer<typeof SessionVm>;
/** Lifecycle actions plus the allow-listed guest operations, as the VM's action log names them. */
export declare const LoggedOperation: z.ZodEnum<{
    create: "create";
    start: "start";
    stop: "stop";
    delete: "delete";
    bootstrap: "bootstrap";
    update_pane: "update_pane";
    prepare_to_stop: "prepare_to_stop";
    collect_diagnostics: "collect_diagnostics";
}>;
export declare const ActionLogEntry: z.ZodObject<{
    id: z.ZodString;
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
    }>;
    parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    actor: z.ZodObject<{
        kind: z.ZodEnum<{
            user: "user";
            host: "host";
            service: "service";
        }>;
        accountId: z.ZodNullable<z.ZodString>;
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
export declare const MemberUsage: z.ZodObject<{
    accountId: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    role: z.ZodEnum<{
        owner: "owner";
        full_access: "full_access";
        view_only: "view_only";
    }>;
    agentHoursUsed: z.ZodNumber;
    awakeNow: z.ZodNumber;
    awakeLimit: z.ZodNumber;
}, z.core.$strict>;
/** An organization's usage for one calendar month (UTC). */
export declare const OrganizationUsage: z.ZodObject<{
    organizationId: z.ZodString;
    plan: z.ZodEnum<{
        free: "free";
        pro: "pro";
        max: "max";
    }>;
    month: z.ZodString;
    resetsAt: z.ZodISODateTime;
    agentHours: z.ZodObject<{
        used: z.ZodNumber;
        limit: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    members: z.ZodArray<z.ZodObject<{
        accountId: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        role: z.ZodEnum<{
            owner: "owner";
            full_access: "full_access";
            view_only: "view_only";
        }>;
        agentHoursUsed: z.ZodNumber;
        awakeNow: z.ZodNumber;
        awakeLimit: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type OrganizationUsage = z.infer<typeof OrganizationUsage>;
export declare const serviceRoutes: {
    startDeviceSignIn: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        deviceCode: z.ZodString;
        userCode: z.ZodString;
        verificationUri: z.ZodURL;
        verificationUriComplete: z.ZodURL;
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
            email: z.ZodEmail;
            name: z.ZodNullable<z.ZodString>;
            access: z.ZodEnum<{
                invited: "invited";
                waitlisted: "waitlisted";
            }>;
            signupState: z.ZodEnum<{
                needs_phone: "needs_phone";
                needs_card: "needs_card";
                ready: "ready";
            }>;
            organizations: z.ZodArray<z.ZodObject<{
                organizationId: z.ZodString;
                name: z.ZodString;
                personal: z.ZodBoolean;
                role: z.ZodEnum<{
                    owner: "owner";
                    full_access: "full_access";
                    view_only: "view_only";
                }>;
            }, z.core.$strict>>;
        }, z.core.$strict>;
    }, z.core.$strict>], "status">>;
    signOut: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        signedOut: z.ZodLiteral<true>;
    }, z.core.$strict>>;
    getAccount: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        email: z.ZodEmail;
        name: z.ZodNullable<z.ZodString>;
        access: z.ZodEnum<{
            invited: "invited";
            waitlisted: "waitlisted";
        }>;
        signupState: z.ZodEnum<{
            needs_phone: "needs_phone";
            needs_card: "needs_card";
            ready: "ready";
        }>;
        organizations: z.ZodArray<z.ZodObject<{
            organizationId: z.ZodString;
            name: z.ZodString;
            personal: z.ZodBoolean;
            role: z.ZodEnum<{
                owner: "owner";
                full_access: "full_access";
                view_only: "view_only";
            }>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    listVms: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        vms: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            organizationId: z.ZodString;
            createdByAccountId: z.ZodString;
            name: z.ZodString;
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
            memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            paneVersion: z.ZodNullable<z.ZodString>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    createVm: import("./http").Route<z.ZodObject<{
        name: z.ZodString;
        idempotencyKey: z.ZodString;
    }, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        vm: z.ZodObject<{
            id: z.ZodString;
            organizationId: z.ZodString;
            createdByAccountId: z.ZodString;
            name: z.ZodString;
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
            memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            paneVersion: z.ZodNullable<z.ZodString>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>;
        operation: z.ZodObject<{
            id: z.ZodString;
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
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    user: "user";
                    host: "host";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
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
    getVm: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        organizationId: z.ZodString;
        createdByAccountId: z.ZodString;
        name: z.ZodString;
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
        memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        paneVersion: z.ZodNullable<z.ZodString>;
        createdAt: z.ZodISODateTime;
        updatedAt: z.ZodISODateTime;
    }, z.core.$strict>>;
    startVm: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        vm: z.ZodObject<{
            id: z.ZodString;
            organizationId: z.ZodString;
            createdByAccountId: z.ZodString;
            name: z.ZodString;
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
            memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            paneVersion: z.ZodNullable<z.ZodString>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>;
        operation: z.ZodObject<{
            id: z.ZodString;
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
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    user: "user";
                    host: "host";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
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
    stopVm: import("./http").Route<z.ZodObject<{}, z.core.$strict>, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        vm: z.ZodObject<{
            id: z.ZodString;
            organizationId: z.ZodString;
            createdByAccountId: z.ZodString;
            name: z.ZodString;
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
            memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            paneVersion: z.ZodNullable<z.ZodString>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>;
        operation: z.ZodObject<{
            id: z.ZodString;
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
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    user: "user";
                    host: "host";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
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
    deleteVm: import("./http").Route<z.ZodUndefined, z.ZodObject<Record<never, never>, z.core.$strip>, z.ZodObject<{
        vm: z.ZodObject<{
            id: z.ZodString;
            organizationId: z.ZodString;
            createdByAccountId: z.ZodString;
            name: z.ZodString;
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
            memoryGiB: z.ZodUnion<readonly [z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            paneVersion: z.ZodNullable<z.ZodString>;
            createdAt: z.ZodISODateTime;
            updatedAt: z.ZodISODateTime;
        }, z.core.$strict>;
        operation: z.ZodObject<{
            id: z.ZodString;
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
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    user: "user";
                    host: "host";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
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
        }>;
        parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        actor: z.ZodObject<{
            kind: z.ZodEnum<{
                user: "user";
                host: "host";
                service: "service";
            }>;
            accountId: z.ZodNullable<z.ZodString>;
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
            }>;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            actor: z.ZodObject<{
                kind: z.ZodEnum<{
                    user: "user";
                    host: "host";
                    service: "service";
                }>;
                accountId: z.ZodNullable<z.ZodString>;
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
    getUsage: import("./http").Route<z.ZodUndefined, z.ZodObject<{
        month: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        organizationId: z.ZodString;
        plan: z.ZodEnum<{
            free: "free";
            pro: "pro";
            max: "max";
        }>;
        month: z.ZodString;
        resetsAt: z.ZodISODateTime;
        agentHours: z.ZodObject<{
            used: z.ZodNumber;
            limit: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        members: z.ZodArray<z.ZodObject<{
            accountId: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            role: z.ZodEnum<{
                owner: "owner";
                full_access: "full_access";
                view_only: "view_only";
            }>;
            agentHoursUsed: z.ZodNumber;
            awakeNow: z.ZodNumber;
            awakeLimit: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
};
/** Pane's client for the service API. */
export declare function createServiceClient(config: ClientConfig): {
    startDeviceSignIn: () => Promise<{
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        verificationUriComplete: string;
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
            email: string;
            name: string | null;
            access: "invited" | "waitlisted";
            signupState: "needs_phone" | "needs_card" | "ready";
            organizations: {
                organizationId: string;
                name: string;
                personal: boolean;
                role: "owner" | "full_access" | "view_only";
            }[];
        };
    }>;
    signOut: () => Promise<{
        signedOut: true;
    }>;
    getAccount: () => Promise<{
        id: string;
        email: string;
        name: string | null;
        access: "invited" | "waitlisted";
        signupState: "needs_phone" | "needs_card" | "ready";
        organizations: {
            organizationId: string;
            name: string;
            personal: boolean;
            role: "owner" | "full_access" | "view_only";
        }[];
    }>;
    listVms: (organizationId: string) => Promise<{
        vms: {
            id: string;
            organizationId: string;
            createdByAccountId: string;
            name: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted";
            stateReason: "user" | "review" | "host_maintenance" | "host_lost" | "failed" | null;
            memoryGiB: 8 | 16;
            paneVersion: string | null;
            createdAt: string;
            updatedAt: string;
        }[];
    }>;
    createVm: (organizationId: string, name: string, idempotencyKey: string) => Promise<{
        vm: {
            id: string;
            organizationId: string;
            createdByAccountId: string;
            name: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted";
            stateReason: "user" | "review" | "host_maintenance" | "host_lost" | "failed" | null;
            memoryGiB: 8 | 16;
            paneVersion: string | null;
            createdAt: string;
            updatedAt: string;
        };
        operation: {
            id: string;
            vmId: string;
            operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics";
            parameters: Record<string, unknown>;
            actor: {
                kind: "user" | "host" | "service";
                accountId: string | null;
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
    getVm: (vmId: string) => Promise<{
        id: string;
        organizationId: string;
        createdByAccountId: string;
        name: string;
        state: "error" | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted";
        stateReason: "user" | "review" | "host_maintenance" | "host_lost" | "failed" | null;
        memoryGiB: 8 | 16;
        paneVersion: string | null;
        createdAt: string;
        updatedAt: string;
    }>;
    startVm: (vmId: string) => Promise<{
        vm: {
            id: string;
            organizationId: string;
            createdByAccountId: string;
            name: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted";
            stateReason: "user" | "review" | "host_maintenance" | "host_lost" | "failed" | null;
            memoryGiB: 8 | 16;
            paneVersion: string | null;
            createdAt: string;
            updatedAt: string;
        };
        operation: {
            id: string;
            vmId: string;
            operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics";
            parameters: Record<string, unknown>;
            actor: {
                kind: "user" | "host" | "service";
                accountId: string | null;
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
    stopVm: (vmId: string) => Promise<{
        vm: {
            id: string;
            organizationId: string;
            createdByAccountId: string;
            name: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted";
            stateReason: "user" | "review" | "host_maintenance" | "host_lost" | "failed" | null;
            memoryGiB: 8 | 16;
            paneVersion: string | null;
            createdAt: string;
            updatedAt: string;
        };
        operation: {
            id: string;
            vmId: string;
            operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics";
            parameters: Record<string, unknown>;
            actor: {
                kind: "user" | "host" | "service";
                accountId: string | null;
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
    deleteVm: (vmId: string) => Promise<{
        vm: {
            id: string;
            organizationId: string;
            createdByAccountId: string;
            name: string;
            state: "error" | "creating" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "deleted";
            stateReason: "user" | "review" | "host_maintenance" | "host_lost" | "failed" | null;
            memoryGiB: 8 | 16;
            paneVersion: string | null;
            createdAt: string;
            updatedAt: string;
        };
        operation: {
            id: string;
            vmId: string;
            operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics";
            parameters: Record<string, unknown>;
            actor: {
                kind: "user" | "host" | "service";
                accountId: string | null;
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
    requestOperation: (vmId: string, request: UserOperationRequest) => Promise<{
        id: string;
        vmId: string;
        operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics";
        parameters: Record<string, unknown>;
        actor: {
            kind: "user" | "host" | "service";
            accountId: string | null;
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
    listActionLog: (vmId: string, page?: {
        before?: string;
        limit?: number;
    }) => Promise<{
        entries: {
            id: string;
            vmId: string;
            operation: "create" | "start" | "stop" | "delete" | "bootstrap" | "update_pane" | "prepare_to_stop" | "collect_diagnostics";
            parameters: Record<string, unknown>;
            actor: {
                kind: "user" | "host" | "service";
                accountId: string | null;
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
    getUsage: (organizationId: string, month?: string) => Promise<{
        organizationId: string;
        plan: "free" | "pro" | "max";
        month: string;
        resetsAt: string;
        agentHours: {
            used: number;
            limit: number | null;
        };
        members: {
            accountId: string;
            name: string | null;
            role: "owner" | "full_access" | "view_only";
            agentHoursUsed: number;
            awakeNow: number;
            awakeLimit: number;
        }[];
    }>;
};
export type ServiceClient = ReturnType<typeof createServiceClient>;
/**
 * The service's allow-list check for a user's operation request: operation_not_allowed for any name
 * outside USER_OPERATIONS, invalid_request for parameters outside that operation's fixed schema.
 */
export declare function parseUserOperation(body: SubmittedOperation): UserOperationRequest;
