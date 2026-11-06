# pane-cloud-contract

The two APIs Pane Cloud is built against, with schemas, typed clients, in-memory stub servers and
contract tests:

- **Service API**: what desktop Pane's Pane Cloud adapter calls on the Pane Cloud service.
- **Fleet API**: what the Pane Cloud service calls on the fleet (the host agent and scheduler).

The zod schemas in `src/service.ts` and `src/fleet.ts` are the contract. Types come from them, the
clients parse every response with them, and the stubs check every request and answer against them.

## Use it

| Import | What it gives you |
| --- | --- |
| `pane-cloud-contract` | Schemas and types, `createServiceClient`, `createFleetClient`, `signOperation`, `verifyOperation`, `CloudApiError` |
| `pane-cloud-contract/stubs` | `startServiceStub` and `startFleetStub`: in-memory servers on a free local port; each resolves to `{ url, close() }` plus test controls |
| `pane-cloud-contract/testing` | `serviceContractCases` and `fleetContractCases`: the contract tests, framework-agnostic, plus `createLocalSigner` |

Inside the Pane workspace, depend on `"pane-cloud-contract": "workspace:*"`. From
`greenfield-inc/pane-cloud`, depend on the Pane repo at a pinned commit:

```json
"pane-cloud-contract": "github:greenfield-inc/Pane#<commit>&path:/packages/pane-cloud-contract"
```

The built `dist` is committed (CI checks it matches the source), so installing from GitHub runs no
build and needs no build-script allowance.

Run the contract tests against your own server, in any test framework. This wires both suites to
the stubs with `node:test`:

```ts
import { test, after } from 'node:test';
import { createServiceClient } from 'pane-cloud-contract';
import { startFleetStub, startServiceStub } from 'pane-cloud-contract/stubs';
import { createLocalSigner, fleetContractCases, serviceContractCases } from 'pane-cloud-contract/testing';

// Service: three GitHub test accounts. `owner` is in the cohort and gets a team of one at sign-in;
// `teammate` and `outsider` are waitlisted.
const logins = { owner: 'alice', teammate: 'bob', outsider: 'eve' };
const service = await startServiceStub({
  accounts: [{ githubLogin: 'alice', cohort: true }, { githubLogin: 'bob', cohort: false }, { githubLogin: 'eve', cohort: false }],
});
// signIn runs the device flow; on the stub, approveDevice stands in for the person approving on GitHub.
const signIn = async (who) => {
  const client = createServiceClient({ baseUrl: service.url });
  const { deviceCode, userCode } = await client.startDeviceSignIn();
  service.approveDevice(userCode, logins[who]);
  return (await client.pollDeviceSignIn(deviceCode)).token;
};
for (const c of serviceContractCases({ baseUrl: service.url, logins, signIn })) test(c.name, c.run);

// Fleet: a key the fleet trusts, one it doesn't, and a release it may install.
const trusted = createLocalSigner('service-key');
const untrusted = createLocalSigner('service-key');
const release = { version: '2.4.215', arch: 'arm64', debSha256: 'c'.repeat(64) };
const fleet = await startFleetStub({ trustedKeys: { 'service-key': trusted.publicKeyPem }, publishedReleases: [release] });
for (const c of fleetContractCases({ baseUrl: fleet.url, token: 'any', signer: trusted.signer, untrustedSigner: untrusted.signer, release })) {
  test(c.name, c.run);
}
after(() => Promise.all([service.close(), fleet.close()]));
```

Against a real server, `signIn` signs in the same three test accounts however that server allows
in test mode, and `token` is the fleet API credential. The fleet's own authentication of the
service (an AWS role) is set up with the infrastructure, outside this contract.

Each side runs the cases for the API it serves and builds against a stub of the API it calls. The service (S1) runs `serviceContractCases` against itself
and builds on `startFleetStub`; the fleet (F2) runs `fleetContractCases` against itself; the desktop
adapter (A3) builds on `startServiceStub`. This package's own test runs both suites against both
stubs: `pnpm --filter pane-cloud-contract test`.

## Errors

Every error response is `{ "error": { "code", "message", "next" } }`, and each code has one HTTP
status (`ERROR_STATUS` in `src/errors.ts`). The clients throw `CloudApiError` for these, and
`ContractViolationError` for any response outside the contract.

## Service API

Bearer token from device sign-in on every route except the two sign-in calls.

| Call | Route | Notes |
| --- | --- | --- |
| Start sign-in | `POST /v1/auth/device` | GitHub device flow for identity only; the service keeps no GitHub token |
| Finish sign-in | `POST /v1/auth/token` | `pending`, `slow_down`, `expired`, `denied`, or `complete` with a token and the account |
| Sign out | `POST /v1/auth/sign-out` | |
| Account | `GET /v1/account` | `access: waitlisted` is "You're on the list"; lists pending team invites |
| Confirm Tailscale login | `PUT /v1/account/tailscale-login` | So hosts and teammates know whom to expect |
| List machines | `GET /v1/machines` | The caller's own, deleted ones left out |
| Create | `POST /v1/machines` | `202`; one machine per seat (`seat_has_machine`); `idempotencyKey` makes a retry return the same machine; `not_invited` when waitlisted |
| Status | `GET /v1/machines/:machineId` | State, tailnet login link (owner only), Pane version, the machine size limits, today's CPU budget use |
| Start, stop | `POST /v1/machines/:machineId/start`, `/stop` | `202`; `invalid_state` if the machine is already running (start) or stopped (stop) |
| Delete | `DELETE /v1/machines/:machineId` | `202`; deletes the disk |
| Run an operation | `POST /v1/machines/:machineId/operations` | Only `update_pane` (`{ version? }`, latest release when omitted; the service looks up the checksum) and `collect_diagnostics` (`{}`); any other name is `operation_not_allowed` |
| Action log | `GET /v1/machines/:machineId/operations` | Newest first, `?before=<id>&limit=`; every lifecycle step and operation with actor, reason and parameters |
| Share with team | `PUT /v1/machines/:machineId/sharing` | Lists the machine in the team directory; admits nobody |
| Leave a connection code | `POST /v1/machines/:machineId/connection-codes` | Owner only, shared machines only, for one teammate, expires within 15 minutes |
| Claim a connection code | `POST /v1/machines/:machineId/connection-codes/claim` | The named teammate, once |
| Billing | `GET /v1/billing` | The team's plan, seat price, founding-price lock, status and dates |
| Team | `GET /v1/team` | Members (each a seat) and pending invites |
| Invite | `POST /v1/team/invites` | Owner only, by GitHub login |
| Revoke invite | `DELETE /v1/team/invites/:inviteId` | Owner only |
| Accept invite | `POST /v1/invites/:inviteId/accept` | The invited login |
| Remove member | `DELETE /v1/team/members/:accountId` | Owner only; unlists their shared machines |
| Shared machines | `GET /v1/team/machines` | The team directory that Pane's Team list under Your computers reads |

No service route grants anyone access to a machine. Machine routes answer only the owner, and
anyone else gets `machine_not_found`; teammates reach only the team directory and a code relayed to
them by name. A
teammate gets in only when the owner approves them on the host, from the owner's own Pane.
Connection codes are minted on the host by the owner's Pane; the service only holds one for the
named teammate to pick up, and the host still checks the teammate's Tailscale login and the
owner's approval.

## Fleet API

Called only by the service. Every change to a machine is one signed operation.

| Call | Route | Notes |
| --- | --- | --- |
| Submit an operation | `POST /v1/operations` | `202` with its status; resending a `requestId` returns the first result; a different payload under a used `requestId` is `invalid_request` |
| Operation status | `GET /v1/operations/:requestId` | `accepted`, `running`, `succeeded` or `failed` |
| Machine | `GET /v1/machines/:machineId` | State, last stop reason, host, Pane version, tailnet status |
| Metrics | `GET /v1/machines/:machineId/metrics?day=` | CPU seconds against the 43,200-second daily budget, resident memory, disk, egress |
| Events | `GET /v1/events?after=&limit=` | What the fleet did on its own (idle stop, memory-pressure stop, budget used), with a cursor |

### The allow-list

| Operation | Runs on | Parameters |
| --- | --- | --- |
| `create` | host | none; the same fixed size limits for every machine (`MACHINE_LIMITS`) |
| `resume`, `stop`, `delete` | host | none; stop snapshots memory and disk |
| `bootstrap` | guest | `release`: a published Pane `version`, `arch: arm64` and the `.deb`'s `debSha256` |
| `update_pane` | guest | the same `release`; the host refuses a checksum that is not a published release |
| `prepare_to_stop` | guest | none |
| `collect_diagnostics` | guest | none; reads only `DIAGNOSTIC_FILES` |

There is no shell command, file write or access grant, and every schema is strict, so an extra
parameter is refused.

### Signing

An operation is `{ payload, signature }`. The payload holds `requestId` (a UUID), `machineId`,
`operation`, `parameters`, `reason` (shown to the user) and `issuedAt`/`expiresAt`, at most 300
seconds apart. The signature is ECDSA P-256 with SHA-256 (AWS KMS `ECDSA_SHA_256`), base64 DER, over
the bytes `pane-cloud-operation-v1\n` followed by the payload's canonical JSON: keys sorted at every
level, no whitespace (`canonicalJson`). `verifyOperation` is the host agent's check: allow-list,
strict parameters, a trusted `keyId`, the signature, then the time window with 30 seconds of clock
skew. The host runs nothing it refuses. A host must remember each `requestId` at least until its
`expiresAt` plus the skew; after that the time window refuses a replay on its own.
