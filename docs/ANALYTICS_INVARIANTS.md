# Analytics Invariants

These rules keep Pane's PostHog funnel person-stitchable and privacy-safe. Pane
uses default-on product analytics for new and previously undecided installs.
Privacy Settings clearly discloses that default and provides the opt-out.
Explicit choices from older versions must never be overwritten.

## Bundled Executable Code

Import the SDK through `posthog-js/dist/module.no-external` and keep
`disable_external_dependency_loading` enabled. This is PostHog's
[supported entry point for Electron](https://posthog.com/docs/libraries/js):
analytics requests and JSON configuration remain available, while executable
configuration, session replay, surveys, and other remote extensions cannot load.
All executable dependencies must come from the reviewed, lockfile-pinned build.
Do not add a second import from the default SDK entry point.

## Identity Comes First

Resolve analytics identity in the main process before the renderer captures any
analytics disclosure or choice event.

Required ordering:

1. Resolve GitHub CLI email, git email, or stable `install_id`.
2. Persist the analytics identity in config.
3. Capture `analytics_default_enabled` for an undecided install entering the
   default-on experiment.
4. Capture `analytics_opted_in` or `analytics_opted_out` for explicit Settings
   choices.
5. Capture `app_first_opened` and usage events only after the default or choice
   is applied.

Do not flush queued usage until the initial default or stored choice has been
resolved. Opting out must capture the choice marker directly, discard queued
usage, and leave the PostHog SDK opted out.

## Existing Choice Preservation

`analytics_consent_shown=true` records an explicit choice made under the legacy
opt-in dialog. Its stored `analytics.enabled` value is authoritative. Never
replace an explicit `false` with the default-on value. The
`analytics_default_applied` distinguishes installs already processed by the
new experiment from previously undecided installs.

## Required Event Context

Every first-run funnel event must include:

- `distinct_id`
- `install_id`
- `app_version`
- `platform`
- `identity_source`

The event should also set person properties when the identity is known
(`personProperties` in `frontend/src/services/posthog.ts`):

- `install_id`
- `identity_source`
- `github_username`
- `github_email`
- `git_email`
- `git_email_sha256`
- `git_user_name`
- `app_version`
- `platform`

Privacy Settings must disclose that analytics can be associated with locally
available GitHub or Git account details, including a username or email. Do not
describe this telemetry as anonymous while those person properties are sent.

## Opt-Out Is Still Identified

Capture `analytics_opted_out` with identity context before disabling analytics.
After that capture, discard queued usage events and keep analytics disabled.

This records who opted out without sending their later product usage.

## Config Saves Preserve Analytics Fields

Renderer settings updates must deep-merge analytics config instead of replacing
it. In particular, do not drop the identity fields in `analytics`
(`main/src/types/config.ts`):

- `installId`
- `distinctId`
- `identitySource`
- `githubUsername`, `githubEmail`, `gitEmail`, `gitEmailHash`, `gitUserName`

## Attribution and Versioning

When web attribution is present, emit attribution events with the same
`distinct_id` and `install_id` as consent and usage events.

App version should come from the running app context and be attached to disclosure,
first-open, usage, attribution, and close events. This lets PostHog distinguish
current users from older installs.

## Remote Pane Privacy

Remote Pane analytics must use explicit sanitized events. Do not rely on
autocapture for Remote Pane connection-code, token, host, or command surfaces.
Any UI that renders or accepts `pane-remote://` codes, remote access tokens, or
remote setup commands must include `ph-no-capture`.

SSH host aliases from the user's SSH config never go into events or logs sent
off the machine. The SSH hosts sidebar section and the SSH view carry
`ph-no-capture`.

Remote Pane events must never include:

- connection codes
- bearer tokens
- token hashes
- base URLs
- hostnames or IP addresses
- profile labels
- client labels
- device labels
- raw error messages
- local paths or Pane data directories
- remote runtime ids

Allowed properties should stay enum-like: `surface`, `role`, `flow`, `result`,
`tunnel_preference`, `tunnel_kind`, `data_mode`, `client_kind`,
`connection_mode`, `failure_stage`, `failure_category`, and connected-client
count buckets.

## Remote Pane Event Catalog

| Event | Primary source | Funnel role |
|---|---|---|
| `remote_pane_host_setup_started` | `main/src/ipc/remoteDaemon.ts` | Host setup started |
| `remote_pane_host_setup_succeeded` | `main/src/ipc/remoteDaemon.ts` | Host setup completed |
| `remote_pane_host_setup_failed` | `main/src/ipc/remoteDaemon.ts`, `main/src/daemon/remoteTransportController.ts` | Host setup or transport failed |
| `remote_pane_setup_terminal_opened` | `main/src/ipc/remoteDaemon.ts` | Setup command opened in terminal |
| `remote_pane_connection_code_created` | `main/src/ipc/remoteDaemon.ts` | Host code created |
| `remote_pane_connection_pair_created` | `main/src/ipc/remoteDaemon.ts` | Advanced paired profile created |
| `remote_pane_connection_code_imported` | `main/src/ipc/remoteDaemon.ts` | Client imported code |
| `remote_pane_connection_code_import_failed` | `main/src/ipc/remoteDaemon.ts` | Client import failed |
| `remote_pane_client_connect_started` | `main/src/daemon/client/remotePaneClient.ts` | Desktop client connection started |
| `remote_pane_client_connected` | `main/src/daemon/client/remotePaneClient.ts`, `main/src/daemon/httpApiServer.ts` | Desktop client connected |
| `remote_pane_client_connection_failed` | `main/src/daemon/client/remotePaneClient.ts`, `main/src/ipc/remoteDaemon.ts` | Desktop client connection failed |
| `remote_pane_client_disconnected` | `main/src/daemon/client/remotePaneClient.ts`, `main/src/daemon/httpApiServer.ts` | Desktop client disconnected |
| `remote_pane_profile_deleted` | `main/src/ipc/remoteDaemon.ts` | Client profile removed |
| `remote_pane_host_access_cleared` | `main/src/ipc/remoteDaemon.ts` | Host access revoked |
| `remote_pane_host_clients_disconnected` | `main/src/ipc/remoteDaemon.ts` | Host disconnected clients |
| `remote_pane_host_transport_started` | `main/src/daemon/remoteTransportController.ts` | Host transport live |
| `remote_pane_host_transport_stopped` | `main/src/daemon/remoteTransportController.ts` | Host transport stopped |
| `remote_pane_pwa_client_connected` | `main/src/daemon/httpApiServer.ts` | Browser/PWA client connected |
| `remote_pane_pwa_client_disconnected` | `main/src/daemon/httpApiServer.ts` | Browser/PWA client disconnected |
| `remote_pane_remote_runtime_used` | `main/src/daemon/client/remotePaneClient.ts` | Remote runtime actually used |

## Failure Volume and Error Privacy

Keep core desktop activity (`app_opened`, `app_closed`, `session_created`,
`panel_switched`, `terminal_panel_created`). Neither wrapper emits routine
command starts or successes. Preserve sanitized wrapper failures and download
lifecycle events; honor explicit local analytics opt-out as well as CI and
`RUNPANE_TELEMETRY_DISABLED`.

Local control emits only `runpane_local_control_failed` for thrown failures or
handled `ok: false` results. Normal wait deadlines and optional agent
unavailability are excluded. Its properties are `action`, `status`, `command_ok`,
`failure_kind`, `error_type`, `error_code`, and `failure_category`, plus app version,
platform and Electron version. Each coarse operation/category/code combination
reports at most once per five minutes, with an overall cap of 20 per hour per
app process. Limits are in memory and reset on restart. Local logging remains
independent of analytics suppression.

Production ingestion drops legacy `runpane_wrapper_command_started`,
`runpane_wrapper_command_succeeded`, and `runpane_local_control`. Keep the new
failure event name separate so useful failures survive these exclusions.

PostHog `$exception` events are reserved for app errors: renderer global errors
and unhandled rejections, React error boundaries, unexpected renderer crashes/OOM,
main uncaught exceptions, and shutdown errors. Console errors and handled CLI
failures never become exceptions. Exceptions have their own five-minute
deduplication and 20-per-hour cap. Both error event paths send directly from main
through PostHog's capture API, with at most four concurrent requests and a 1.5s
timeout; neither waits for delivery. Errors obey analytics opt-out and use only
the existing install UUID identity, without person-profile updates, account
properties, SDK URL enrichment or persistent error storage.

Exception payloads contain coarse source, built-in error type, allowlisted error
code/category, version/platform, a fixed message, and up to ten packaged app JS
frames. Frames contain relative app filenames and numeric line/column offsets,
never absolute paths, function names or source context. Raw messages, causes,
CLI argv, terminal contents, prompts, source code, repository paths, usernames,
home paths and environment values are excluded. Development/server URLs and
external dependency frames are omitted. Restricted interactive-element
autocapture and pageviews stay enabled, with text and attributes masked;
automatic exception capture is disabled. Session replay policy is unchanged.

Main fatal capture uses `uncaughtExceptionMonitor`, preserving exit behavior.
Delivery during process exit is best effort. Native main-process aborts and
segfaults cannot be captured by JavaScript; there is no minidump uploader or
source-map upload pipeline. Renderer process loss reports a coarse crash reason
without a native stack. Native crash reporting remains a separate follow-up.
PostHog's [Electron support request](https://github.com/PostHog/posthog/issues/43993)
does not provide native Electron crash support. The payload follows the supported
[manual exception schema](https://posthog.com/docs/error-tracking/installation/manual)
for JavaScript errors; this is not a replacement for native Electron crash reporting.
Source-map symbolication is not wired or verified: current reports contain
packaged JavaScript offsets only, and a future source-map upload integration must
be verified against a packaged build before claiming original TypeScript locations.

## Test Coverage

Changes to disclosure, analytics config, or first-run event ordering should update
or add coverage in:

- `main/src/services/analyticsIdentity.test.ts`
- `tests/analytics-consent.spec.ts`

The Playwright test should verify both event order and payload shape, including
SDK identity and interaction events, and reject external script requests even
when remote configuration enables extensions.
