# pane-cloud-contract

The two APIs Pane Cloud is built against, with schemas, typed clients, in-memory stub servers and
contract tests:

- **Service API**: what Pane (desktop, phone, runpane) calls on the Pane Cloud service.
- **Fleet API**: what the Pane Cloud service calls on the fleet's host agent.

The zod schemas in `src/service.ts` and `src/fleet.ts` are the contract. Types come from them, the
clients parse every response with them, and the stubs check every request and answer against them.

## Use it

| Import | What it gives you |
| --- | --- |
| `pane-cloud-contract` | Schemas and types, `PLANS`, `createServiceClient`, `createFleetClient`, `signOperation`, `verifyOperation`, `CloudApiError` |
| `pane-cloud-contract/stubs` | `startServiceStub` and `startFleetStub`: in-memory servers on a free local port; each resolves to `{ url, close() }` plus test controls |
| `pane-cloud-contract/testing` | `serviceContractCases` and `fleetContractCases`: the contract tests, framework-agnostic, plus `createLocalSigner` |

Inside the Pane workspace, depend on `"pane-cloud-contract": "workspace:*"`. From the private
control-plane repo (the service and the host agent), depend on the Pane repo at a pinned commit:

```json
"pane-cloud-contract": "github:greenfield-inc/Pane#<commit>&path:/packages/pane-cloud-contract"
```

Install it with pnpm: npm ignores `&path:` and installs the whole repo instead. The built `dist` is
committed (CI checks it matches the source), so nothing builds on install, but pnpm still asks to
allow a git dependency's install scripts. On pnpm 10 it only warns; to silence it, list
`pane-cloud-contract` in `onlyBuiltDependencies` in `package.json`'s `pnpm` field. On pnpm 11 and
later the install fails until you add the key its error prints to `allowBuilds` in
`pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "pane-cloud-contract@https://codeload.github.com/greenfield-inc/Pane/tar.gz/<commit>#path:/packages/pane-cloud-contract": true
```

Run the contract tests against your own server, in any test framework. This wires both suites to
the stubs with `node:test`:

```ts
import { test, after } from 'node:test';
import { createServiceClient, type PaneRelease } from 'pane-cloud-contract';
import { startFleetStub, startServiceStub } from 'pane-cloud-contract/stubs';
import { createLocalSigner, fleetContractCases, serviceContractCases, SkipCase } from 'pane-cloud-contract/testing';

// Service: three test accounts. `member` is invited and signed up, `unverified` still needs its
// phone check, `waitlisted` is not invited.
const emails = { member: 'member@example.test', unverified: 'unverified@example.test', waitlisted: 'waitlisted@example.test' };
const service = await startServiceStub({
  accounts: [
    { email: emails.member, invited: true },
    { email: emails.unverified, invited: true, signupState: 'needs_phone' },
    { email: emails.waitlisted, invited: false },
  ],
});
// signIn runs device sign-in; on the stub, approveDevice stands in for the person signing in.
const signIn = async (who: keyof typeof emails) => {
  const client = createServiceClient({ baseUrl: service.url });
  const { deviceCode, userCode } = await client.startDeviceSignIn();
  service.approveDevice(userCode, emails[who]);
  const result = await client.pollDeviceSignIn(deviceCode);
  if (result.status !== 'complete') throw new Error(`sign-in ended ${result.status}`);
  return result.token;
};
// No controls here, so the cases that need one report themselves skipped.
for (const c of serviceContractCases({ baseUrl: service.url, emails, signIn })) {
  test(c.name, async (t) => {
    try {
      await c.run();
    } catch (error) {
      if (!(error instanceof SkipCase)) throw error;
      t.skip(error.message);
    }
  });
}

// Fleet: a key the fleet trusts, one it doesn't, and a release it may install.
const trusted = createLocalSigner('service-key');
const untrusted = createLocalSigner('service-key');
const release: PaneRelease = { version: '2.4.215', arch: 'arm64', debSha256: 'c'.repeat(64) };
const fleet = await startFleetStub({ trustedKeys: { 'service-key': trusted.publicKeyPem }, publishedReleases: [release] });
for (const c of fleetContractCases({ baseUrl: fleet.url, token: 'any', signer: trusted.signer, untrustedSigner: untrusted.signer, release, hostId: 'stub-host-1' })) {
  test(c.name, c.run);
}
after(() => Promise.all([service.close(), fleet.close()]));
```

Against a real server, `signIn` signs in the same three test accounts however that server allows
in test mode, and `token` is the fleet API credential. The fleet's own authentication of the
service (an AWS role) is set up with the infrastructure, outside this contract.

Each side runs the cases for the API it serves and builds against a stub of the API it calls: the
service runs `serviceContractCases` against itself and builds on `startFleetStub`; the host agent
runs `fleetContractCases`; Pane builds on `startServiceStub`. This package's own test runs both
suites against both stubs: `pnpm --filter pane-cloud-contract test`.

Some service cases need test-mode setup: pass `controls` to `serviceContractCases` with any of
`pauseForReview`, `setCapacity`, `addMember`, `setPlan`, `setMemoryGiB` and `setClock`
(`ServiceContractControls`). A case whose control is missing throws `SkipCase`; report it as
skipped. `setClock` only moves forward, so run the cases in order. Without controls, the cases
that need them are the review pause, `no_capacity`, a second organization with Full access and
View only members, and agent-hour metering.

The service stub gives every account a personal organization on the Free plan, starts and stops
VMs at once, and counts agent-hours from its clock (pass `now` to move it). Its controls are
`approveDevice` and `denyDevice` for sign-in, plus each of the controls above; this package's own
test shows the wiring.

## Errors

Every error response is `{ "error": { "code", "message", "next" } }`, and each code has one HTTP
status (`ERROR_STATUS` in `src/errors.ts`). The clients throw `CloudApiError` for these, and
`ContractViolationError` for any response outside the contract.

## Plans

`PLANS` holds D-64's three plans: hours per Full access member a month, pooled across the
organization, and the awake limit per member. The awake limit spans the account (D-74): a person's
awake Session VMs in every organization count together, against the highest limit among their
Full access memberships. A View only member adds no hours, has an awake limit of 0 in that
organization, and gets `view_only` from create and start there.

| Plan | Agent-hours per member a month | Awake at once per member |
| --- | --- | --- |
| `free` | 300 | 5 |
| `pro` | 1,500 | 20 |
| `max` | 3,000 | 50 |

An agent-hour is one hour a Session VM is awake (creating, starting or running); an hour at 16 GiB
counts as 2 (`AGENT_HOURS_PER_AWAKE_HOUR`). An organization's usage can carry a per-member awake
limit other than its plan's, and a null hour limit, for organizations with admin overrides.

## Service API

Bearer token from device sign-in on every route except the two sign-in calls.

| Call | Route | Notes |
| --- | --- | --- |
| Start sign-in | `POST /v1/auth/device` | Pane opens `verificationUriComplete` in the system browser |
| Finish sign-in | `POST /v1/auth/token` | `pending`, `slow_down`, `expired`, `denied`, or `complete` with a token and the account |
| Sign out | `POST /v1/auth/sign-out` | |
| Account | `GET /v1/account` | `access: waitlisted` is "You're on the list"; `signupState` is the next sign-up step (`needs_phone`, `needs_card`, `ready`); the account's organizations, the personal one marked |
| List Session VMs | `GET /v1/organizations/:organizationId/vms` | The caller's own in that organization, deleted ones left out |
| Create | `POST /v1/organizations/:organizationId/vms` | `202`; an 8 GiB VM that starts at once; `not_org_member`, `view_only`, `not_invited`, `signup_incomplete`, `awake_limit_reached`, `no_capacity`; a retry with the same key in the same organization returns the first VM |
| Get | `GET /v1/vms/:vmId` | State, why it last stopped, memory, Pane version |
| Start, stop | `POST /v1/vms/:vmId/start`, `/stop` | `202`; `invalid_state` if it is already running (start) or stopped (stop); start answers `under_review` for a VM paused for review, and `awake_limit_reached` or `no_capacity` like create |
| Delete | `DELETE /v1/vms/:vmId` | `202`; deletes the disk |
| Run an operation | `POST /v1/vms/:vmId/operations` | Only `update_pane` (`{ version? }`, latest release when omitted; the service looks up the checksum) and `collect_diagnostics` (`{}`); any other name is `operation_not_allowed` |
| Action log | `GET /v1/vms/:vmId/operations` | Newest first, `?before=<id>&limit=`; every lifecycle step and operation with actor, reason and parameters |
| Usage | `GET /v1/organizations/:organizationId/usage` | `?month=YYYY-MM`, this month by default: the plan, agent-hours used and the pooled limit, when they reset, and per member their hours, VMs awake now and awake limit |

A Session VM answers only the member who created it; anyone else gets `vm_not_found`. Organization
routes answer only members (`not_org_member`). No route grants anyone access to a VM.

## Fleet API

Called only by the service. Every change to a VM is one signed operation.

| Call | Route | Notes |
| --- | --- | --- |
| Submit an operation | `POST /v1/operations` | `202` with its status; resending a `requestId` returns its first outcome, a refusal included; a different payload under a used `requestId` is `invalid_request`; the status of a refused operation is `failed` with its error |
| Operation status | `GET /v1/operations/:requestId` | `accepted`, `running`, `succeeded` or `failed` |
| VM | `GET /v1/vms/:vmId` | State, last stop reason, host, memory, Pane version |
| Metrics | `GET /v1/vms/:vmId/metrics?day=` | CPU seconds, resident memory, disk, and egress for a UTC day |
| Events | `GET /v1/events?after=&limit=` | Every state change and finished operation, with a cursor; the service meters agent-hours from the state changes |

### The allow-list

| Operation | Runs on | Parameters |
| --- | --- | --- |
| `create` | host | none; an 8 GiB, 4 vCPU VM, started |
| `start`, `delete` | host | none |
| `stop` | host | `cause`: `user` or `review` (an automatic pause or a person's Suspend), recorded as the VM's `stateReason`; the disk is kept. The fleet's own stops (host maintenance, host loss) set their own reason |
| `bootstrap` | guest | `release`: a published Pane `version`, `arch: arm64` and the `.deb`'s `debSha256` |
| `update_pane` | guest | the same `release`; the host refuses a checksum that is not a published release |
| `prepare_to_stop` | guest | none |
| `collect_diagnostics` | guest | none; reads only `DIAGNOSTIC_FILES` |

There is no shell command, file write or access grant, and every schema is strict, so an extra
parameter is refused.

### Signing

An operation is `{ payload, signature }`. The payload holds `requestId` (a UUID), `hostId` (the host
that should run it), `vmId`,
`operation`, `parameters`, `reason` (shown to the user) and `issuedAt`/`expiresAt`, at most 300
seconds apart. The signature is ECDSA P-256 with SHA-256 (AWS KMS `ECDSA_SHA_256`), base64 DER, over
the bytes `pane-cloud-operation-v1\n` followed by the payload's canonical JSON: keys sorted at every
level, no whitespace (`canonicalJson`). `verifyOperation` is the host agent's check, in order: the
allow-list, strict parameters, a trusted `keyId`, the signature, the time window, then the host.
The window refuses an operation whose `issuedAt` is more than 30 seconds ahead of the host's clock,
whose `expiresAt` has passed, or whose two times are more than 300 seconds apart (`operation_expired`).
An operation signed for another host is `wrong_host`. Once an operation passes these checks, the
host records its `requestId` before running anything, and remembers it at least until `expiresAt`;
a resend inside that time gets the first outcome, and after it the window refuses the resend on
its own.
