---
name: pr-test-automation
description: Run first-pass automated manual testing for PRs that are reviewed or nearly ready to merge. Use when the user asks to test a PR/branch/worktree, validate product flows, exercise browser or CLI workflows, map changed UI journeys with screenshots, verify analytics/webhooks/payments/email/SMS behavior through connected tools, or produce manual QA notes before human testing.
---

# PR Test Automation

## Overview

Validate as much of a PR as possible with local services, browser automation, CLIs, logs, and product connectors before the user does final manual testing. Treat this as a first-pass QA workflow: prove what works with evidence, identify what still needs a human, and preserve a reproducible trail.

## Workflow

1. Confirm the test target:
   - Identify PR numbers, branches, worktrees, related companion PRs, and whether the user allowed rebasing/syncing.
   - Check `git status`, current branch, remotes, and whether unrelated local changes exist.
   - Inspect PR descriptions/review notes when they define required manual flows.

2. Check tools and authentication up front:
   - Verify required CLIs and connectors before starting long tests: `gh auth status`, `stripe --version` / active listener state, Docker status, PostHog/GitHub/Gmail connectors, cloud CLIs, or app-specific CLIs.
   - Discover verification tools before assuming a manual check is required. If Composio is available, use `composio search` to find candidate inbox, SMS/phone, payment, CRM, support, or provider-log tools, then inspect schemas with `--get-schema` before executing.
   - Prefer connected app tools for product data verification. Do not assume credentials are current.
   - Use test-mode accounts, test keys, local containers, and staging-safe endpoints unless the user explicitly asks for production verification.

3. Prepare the environment:
   - Install dependencies only where needed and report anything that changes lockfiles.
   - Start required dev servers or confirm existing sessions, ports, and mounted worktrees.
   - For companion PRs, test the combined state in the worktree/container that actually serves the code.
   - Avoid leaving duplicate background listeners or servers. List and clean up only processes started for the test.

4. Build the automated test path:
   - Use Playwright when browser behavior matters. If the repo lacks Playwright, install it in a temporary directory rather than polluting the repo.
   - Use stable, user-visible selectors first: labels, placeholders, button text, URLs, and route state.
   - Generate unique short test identities and attribution markers such as `agent-e2e-<timestamp>`.
   - When UI changes are in scope, map each touched surface area and user journey to screenshots in a temporary, easy-to-observe folder such as `tmp/pr-<number>-qa/` or `tmp/<branch>-qa/`. Use ordered filenames that describe the journey step, such as `01-signup-account.png` and `02-dropdown-expanded.png`.
   - Capture meaningful UI states, not only final pages: empty/default, filled/selected, expanded menus, modals, validation errors, loading/success states, and at least one narrow viewport when responsive layout is likely affected.
   - Reuse the same screenshot artifact pattern for local/dev validation and, when the user asks for post-merge production verification, for production paths. Keep local and production artifacts separated by folder or filename.
   - When a journey is driven by a scriptable browser driver, record it as a video alongside the stills. One video per journey, recorded at the driver level (e.g. Playwright's `recordVideo`) so it is a free byproduct of the drive, not a second pass. Keep the driver's native format (WebM from browser, MP4 from simulator). Videos complement stills, never replace them: per-step captures remain the frame-addressable evidence, the video is the continuity check. Where ffmpeg is available, scan for blank-frame bands (`ffprobe -f lavfi "movie=<video>,fps=5,signalstats" -show_entries frame=pts_time -show_entries frame_tags=lavfi.signalstats.YAVG`; YAVG ~235 is blank white) and report layout jumps, white flashes, or dead time as findings with timestamp ranges.
   - Prefer the app's built-in test/simulation path for external effects: local inboxes, Mailhog-style UIs, fake SMS numbers, test OTP logs, sandbox payment modes, webhook listeners, or provider test keys.
   - Parse local email/SMS verification links or codes from container logs when the local environment emits them.
   - Add small human-paced waits around analytics or step-transition tests so effects and batched events have time to fire in the same order a user would experience.

5. Verify externally, not just locally:
   - Network requests prove the browser tried to send data; connector/API queries prove the product received it.
   - When simulation is unavailable, use connected recipient/provider readback: Gmail/Outlook/IMAP or email-service activity for email; Twilio/Dialpad/OpenPhone/Google Voice/test-number services or provider logs for SMS/voice; Stripe/provider dashboards for payments.
   - Query by the unique marker, test email, phone number, org ID, subscription ID, webhook event ID, request ID, or other stable test value.
   - For webhooks, confirm both CLI/listener output and backend logs, then verify downstream data.
   - For analytics dashboards, query the exact project and call out the date range and filters used.

6. Report results:
   - Return what passed, remaining uncertainty, the next check, and up to three improvements grounded in testing friction.

   Open with a verdict, then the evidence. The structure:

   ```
   Verdict: <all-proven | partial | blocked-env | blocked-auth | product-bug-found>

   | Journey / Check | Result | Evidence |
   |-----------------|--------|----------|
   | <flow or check> | Pass / Fail / Blocked / Left to human | <quoted output, screenshot ref, connector readback> |

   Skipped (with rationale):
   - <item>: <why it was skipped, not just "skipped">

   Cleanup disposition:
   | Created | Marker | System | Disposition |
   |---------|--------|--------|-------------|
   | <account, org, record> | <run marker> | <staging / analytics / billing> | deleted · registered (<why not safe>) · none created |
   ```

   A pass without quoted evidence is not a pass. "Blocked" is a terminal
   verdict: when a check cannot be exercised (missing env, service down,
   no credentials), stop trying rather than improvising a workaround.
   Improvised test routes are not evidence.

   Terminal states and what the human should do next:
   - `all-proven`: every check passed with evidence. Ready for human review.
   - `partial`: some checks passed, others left to human. List the gaps.
   - `blocked-env`: environment issue (service down, container missing). Name the blocker.
   - `blocked-auth`: missing credentials or connector scopes. Name what is needed.
   - `blocked-timeout`: wall clock expired before all checks completed. List what finished and what remains.
   - `product-bug-found`: a check failed and the failure is in the product. Describe the bug with evidence.

   Beyond the verdict, the report must include:
   - The exact test identity/marker used for external queries.
   - Screenshot paths for changed UI, organized by journey step with the surface area, environment, and UI state each covers.
   - Video paths for journey recordings, with duration and what each evidences.
   - Connector/query evidence with event names, identifiers, timestamps, and important properties.
   - What was intentionally skipped and why (per item, not a blanket "some things were skipped").
   - Artifacts caused by the test harness (mocked browser properties, prevented navigation, masked automation signals).

   When screenshots are safe to share, publish them on a repository-owned durable asset surface. For GitHub PRs, prefer an existing long-lived release such as `pr-assets`; do not use an arbitrary temporary host when a suitable repository release is available. For GitHub PR targets where the user asked for PR testing, update the PR description with a concise QA summary where reviewers look first. Use a marked section so reruns replace the latest QA summary without overwriting the author-written description. Use a separate marked QA comment for long evidence, logs, and screenshot galleries when the description would become unwieldy.

## PostHog And Browser Analytics

PostHog JavaScript drops capture events from likely bots. Headless Playwright can still fetch PostHog config and run `identify`, while `capture` events are silently dropped because `navigator.webdriver` is `true`, the user agent looks automated, or `navigator.userAgentData.brands` includes `HeadlessChrome`.

When the explicit goal is to validate product analytics in local automation:

- Use a normal browser user agent.
- Mask only the automation bot signals for the test context. Setting `userAgent` is not enough if `navigator.userAgentData` still exposes headless Chrome:

```js
const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
})

await context.addInitScript(() => {
  const brands = [
    { brand: 'Chromium', version: '125' },
    { brand: 'Google Chrome', version: '125' },
    { brand: 'Not.A/Brand', version: '24' },
  ]
  const fullVersionList = brands.map((brand) => ({
    ...brand,
    version: `${brand.version}.0.0.0`,
  }))

  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  Object.defineProperty(navigator, 'userAgentData', {
    get: () => ({
      brands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: async () => ({
        brands,
        mobile: false,
        platform: 'Windows',
        architecture: 'x86',
        bitness: '64',
        model: '',
        uaFullVersion: '125.0.0.0',
        fullVersionList,
      }),
      toJSON: () => ({ brands, mobile: false, platform: 'Windows' }),
    }),
  })
})
```

- If the UI branches on OS or desktop/mobile, set the relevant platform signal intentionally and disclose it:

```js
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })
})
```

- Keep the page open long enough for PostHog batching, or trigger an unload only after waiting.
- Query PostHog for the unique marker. Do not treat `flags` or config requests as evidence that capture events were ingested.
- If event order looks wrong under automation, rerun with human-paced waits before treating it as a product bug.

## Multi-Surface Attribution Flows

Some PRs only work when a marketing site, API route, installer, desktop app, or mobile client is tested as one product flow. When attribution or install/download analytics cross those boundaries:

- Test companion PRs together in the worktree or preview environment that actually serves each surface.
- Validate route-level behavior directly before browser testing. For install/download flows, assert fresh tokens are accepted, stale or malformed tokens are dropped, invalid files or inputs are rejected, and crawler-facing routes are excluded when needed.
- Browser clipboard tests should compare visible UI text with clipboard text. It is common for the visible command/link to stay clean while the copied value includes a hidden `ref`, `utm`, or attribution token.
- If client-side analytics must create a distinct id but production capture is not part of the test, use a dummy public key and intercept analytics endpoints. If production verification is requested, use a unique marker and query the analytics project afterward.
- Use temporary app data directories for native app tests so config migrations, attribution files, cookies, and local databases do not touch the user's real profile.
- For Electron, Tauri, React Native, or similar native-shell mocks, event subscription APIs must return cleanup functions. Promise-returning mocks for `on*` or `subscribe*` APIs can create false crashes that look like product regressions.
- Direct captures that fire before an analytics SDK is fully initialized need explicit host, token, and distinct-id assertions. A request falling back to the SDK vendor default host before app config loads is usually a product bug, not enough evidence that the event will reach the intended project.
- Capture both the happy path and one negative path: accepted/refreshed attribution, stale or malformed attribution, user opt-in or opt-out, and any server-side invalid-input analytics.

## External Integrations

For payment, email, SMS, analytics, and other third-party integrations:

- Confirm the account/project/mode before running tests.
- Prefer test-mode objects and fake/test cards.
- Prefer recipient/provider-side evidence over send-side success. A 200 response from the app or provider is useful but not enough when the PR's behavior depends on actual delivery, ingestion, webhook receipt, or downstream processing.
- Use plus-addresses, reserved fake phone numbers, sandbox identities, metadata, notes, UTM values, or request IDs so every external artifact can be found without ambiguity.
- Respect production stop boundaries. Do not bypass MFA, consume one-time tokens, send real calls/SMS, create paid subscriptions, charge cards, or mutate customer data unless the user explicitly approved that production action.
- Check for duplicate listeners before starting a new webhook listener.
- Record IDs that let the user or future agent find the test again: email, phone number, org key, customer ID, subscription ID, message ID, webhook event type, dashboard URL, event marker, or screenshot path.
- If a provider key lacks read scopes, try another non-destructive readback source such as a connected mailbox, recipient-side tool, provider dashboard export, app database row, webhook table, logs, or analytics event. Report the scope limitation rather than treating it as product failure.
- Never expose secrets in the final answer. Public analytics tokens are not the same as private API keys, but still describe them carefully.

## Durable PR QA Descriptions, Comments, And Screenshots

When testing an open PR, preserve the result where reviewers will look first:

- Create a local artifact folder such as `tmp/pr-<number>-qa/` containing raw screenshots, scripts, the exact PR Markdown, and `pr-assets-manifest.json`.
- Classify every image before upload. Do not upload PHI, secrets, private customer data, real inbox contents, payment details, MFA codes, production admin data, or anything inappropriate for every person who can read the PR. Keep sensitive images local and redact a copy only when the redaction can be verified visually.
- Prefer a repository-owned durable surface. For GitHub PRs, discover and reuse a published, mutable, long-lived release such as `pr-assets` or the repository's documented equivalent:

  ```bash
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
  default_branch="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)"
  gh release list -R "$repo" --limit 100 \
    --json tagName,name,isDraft,isPrerelease
  gh release view pr-assets -R "$repo" \
    --json tagName,isDraft,isPrerelease,isImmutable,url,assets
  ```

  Do not create a release per PR. Do not use an arbitrary temporary host when a suitable repository release exists.
- If no suitable release exists, creating one dedicated long-lived `pr-assets` release is a separate hard stop requiring an exact grant such as `{"action":"create_release","repo":"owner/name","tag":"pr-assets"}`. Generic GitHub, PR, comment, or asset-upload authorization does not grant creation. Use the default branch as its target and keep it out of Latest-release semantics:

  ```bash
  gh release create pr-assets -R "$repo" --title "PR assets" \
    --notes "Long-lived image assets for pull requests and QA evidence." \
    --latest=false --target "$default_branch"
  ```

  If release creation or upload is not authorized, do not fall back to a temporary host. Write the intended filenames, manifest, exact `gh release create` / `gh release upload` commands, and ready-to-paste marked PR Markdown into the artifact folder; report that durable publication is blocked.
- Compute the source SHA-256 before upload. Name every asset with stable context plus content identity, for example `pr-<number>-<head-short-sha>-<content-sha12>-<step>.png`. Use a branch slug when the PR number does not exist yet. Sanitize names to portable lowercase ASCII.
- Make reruns idempotent. Inspect release assets before uploading. If the exact name exists and its GitHub digest (or a downloaded byte-for-byte hash when no digest is present) matches the local file, reuse its URL. If the content differs, do not overwrite or use `gh release upload --clobber`; extend the hash or add a deterministic suffix and upload a new asset so an older PR never changes underneath reviewers.
- Upload with `gh release upload <tag> <path> -R "$repo"`, then read back the release and asset metadata. Require the intended tag, a non-draft release, uploaded asset state, expected filename, size, SHA-256 digest when GitHub supplies it, and `browser_download_url`.
- Perform a direct GET of the uploaded bytes (authenticated through GitHub for private repositories), not only a HEAD request. Compare the downloaded SHA-256 and size with the local source and verify the decoded file type or image magic; an HTML login/error page with a misleading status is a failure. Record the verification timestamp and result.
- Maintain `pr-assets-manifest.json` across reruns. For each asset record the repository, release tag and URL, PR number, head commit, source path, semantic step, asset name, local SHA-256 and size, asset API URL, browser download URL, upload-or-reuse status, timestamp, and content-verification result. Never put tokens, cookies, or sensitive test data in the manifest.
- Treat the PR description as the primary review surface. Append or replace only the section between `<!-- pr-test-automation-summary:start -->` and `<!-- pr-test-automation-summary:end -->` without rewriting the human-authored PR summary. If a legacy `<!-- codex-pr-test-automation-summary -->` section exists, migrate that section once instead of duplicating it. Keep the PR description QA section compact and include:
  - current QA status;
  - test account/org/marker identifiers;
  - user journeys and surface areas tested;
  - key external evidence IDs, such as Stripe subscription IDs, email IDs, PostHog event names, webhook IDs, or database readback;
  - key screenshot previews when UI review is central and the set is small enough to skim;
  - a link to the detailed QA comment or local artifacts when the full evidence is long;
  - what remains for human review and what was intentionally skipped.
- Without a posting grant, render this content as a page (see [page](../page/SKILL.md)) at `tmp/pages/<slug>/qa.html`, open it for the person, and return its path. With a grant, post or update one PR comment whose owned content is bounded by `<!-- pr-test-automation-detail:start -->` and `<!-- pr-test-automation-detail:end -->` when detailed evidence, logs, or screenshot galleries are too large for the PR description. Recognize the legacy `<!-- codex-pr-test-automation -->` marker so reruns update rather than duplicate an older comment. Include:
  - summary of automated manual QA outcome;
  - test account/org/marker identifiers;
  - user journeys and surface areas tested;
  - screenshot previews, not just screenshot links;
  - connector/provider evidence such as PostHog, Stripe, email, SMS, logs, or database readback;
  - what remains for human review and what was intentionally skipped.
- Render safe uploaded screenshots inline so reviewers can skim without opening every link. Do not leave the PR description or QA comment as a plain list of screenshot URLs when UI changed.
- Prefer grouped preview galleries:
  - Use one `<details open>` section per user journey or touched UI surface when there are many screenshots.
  - Put screenshots in chronological order and label each one with the journey step and state it proves.
  - Add a one-sentence explanation for each screenshot that answers: what surface/state is this, and what should the reviewer notice?
  - Use a two-column Markdown/HTML table for compact skimming when there are more than four screenshots.
  - Use direct image URLs in Markdown image syntax or HTML `<img>` tags. If using HTML, constrain width around `360`-`480` pixels so the PR remains readable.
- Keep unsafe screenshots local only and say why. Examples: payment card entry screens, PHI, secrets, private customer data, real inbox contents, MFA codes, or production admin data. Mention their local paths without rendering or uploading them.
- When updating an existing marked QA summary or comment, replace dead, expiring, temporary, or local-only image references with verified durable URLs and inline previews during the same update instead of adding a second comment. Preserve all author-written text outside the markers. If an image URL outside a marker is broken, change only that URL after verifying the intended replacement; do not rewrite the surrounding prose.
- Example compact preview block:

```markdown
<details open>
<summary>Signup journey screenshots</summary>

| Step | Preview |
| --- | --- |
| Account details | Shows the default account form before submission; reviewer should check required fields and spacing.<br><img src="https://example.test/01-account.png" width="420" alt="Account details form"> |
| Validation error | Shows the blocked submit state; reviewer should check copy, focus, and error placement.<br><img src="https://example.test/02-validation.png" width="420" alt="Validation error state"> |

</details>
```
- If PR commenting is not authorized or a connector is unavailable, write the exact Markdown comment body into the artifact folder and report the path.

## Stop Conditions

Stop and ask the user before:

- Running real production payments or destructive production mutations.
- Rebasing, force-pushing, or modifying an open PR if the user has not authorized it.
- Posting comments, sending emails, toggling flags, or changing dashboards unless the user asked for that action.

Otherwise, keep going through setup, execution, verification, cleanup, and a concise result summary.

## Run Bounds

Set a 90-minute wall clock for the entire run. Per-journey, allow at most 2
retry attempts before marking the journey failed or blocked. No combination
of retries extends the wall clock. If the wall clock expires mid-journey,
finalize evidence for what completed, mark in-progress items as
`blocked-timeout`, and report.

## Cleanup Discipline

The run's unique marker names real things that now exist in external systems:
accounts, organizations, records, subscriptions, analytics events. Disclosure
alone is not disposal.

Delete in-run only when all three conditions hold:

1. The surface is **non-production**, established from the environment the drive
   actually reached (the ingestion target, the key, the project id), not
   assumed from the stack you launched.
2. The deletion is **scoped by this run's unique marker**, not a broader query.
3. The drive **already holds** the credentials that perform it.

If any condition fails or is uncertain, do not delete. Register the item:
name the marker, the system, and what remains, precisely enough that a
repo-side reaper can find it by marker alone. Production analytics and
live-mode billing are register-only by default.

Either way the disposition appears in the report's cleanup table. "None
created" is a disposition too, not an excuse to omit the table.

## Analytics Identity Verification

Event ingestion alone is not enough. Verify PERSON STITCHING whenever a PR touches
analytics, signup, login, or session handling:

- Group verification queries by `person_id`, never by `person.properties.*`. Event-time
  person properties differ per row and can make N merged users each look like "one clean
  person". Six merged QA users passed an email-grouped check; a `person_id`-grouped check
  exposed they were all a single person.
- Inspect raw `distinct_id` per event when stitching looks wrong. It names the exact
  identity that captured the event and usually identifies the merge vector directly.
- When the PR touches identity stitching itself (aliasing, identify calls, distinct-id or
  session-identity plumbing), or the product targets shared devices, run a
  **multi-user same-browser pass**: several signups and login switches in one browser
  profile, then assert each user resolved to a separate person AND that functional session
  state (websocket auth, cookies) followed the switch. Shared-machine bugs (identity
  merges, stale-socket auth) are invisible to single-user passes; the pass is expensive,
  so reserve it for changes where that failure mode is actually in play.
- Suspect STACKED causes when a fix's re-verification still fails: fix one vector, re-run
  the proof, and let the raw distinct_id data name the next vector. Do not assume the fix
  simply "didn't work".
- Test events fired immediately before hard navigations (checkout redirects, external
  scheduling links): SDK batching silently drops them on unload; they need per-capture
  `sendBeacon` transport. Absence in the warehouse (not the network tab) is the proof.

## Fix-Verify Loop Hygiene

- Before driving a browser proof of a just-committed fix, verify the SERVED bundle
  contains it (fetch the bundle URL and grep a distinctive marker, or compare the hash in
  page/script URLs). Dev-server rebuild races cost entire proof rounds and mimic "fix
  didn't work".
- Wait ~45-60s before querying an analytics warehouse for just-captured events; an empty
  result inside that window proves nothing.

## Browser-Extension and Vendor Interference

- Password-manager extensions (1Password) steal focus into extension frames on
  credential-like fields; afterwards ALL automation on the tab fails with
  "Cannot access a chrome-extension:// URL". Prefer setting form values by element
  reference over click+type, dismiss popovers by clicking neutral page areas (Escape may
  feed the popover), and recover a wedged tab only by opening a fresh one (hosted
  checkout URLs resume by URL).
- Export GIF recordings BEFORE closing their tab. Recordings die with the tab group.
- Vendor sandboxes rate-limit (e.g. Dropbox Sign test API throttles after ~6 signature
  requests/day, stalling embeds ~10 min). Budget signature-heavy passes and report
  throttling as an environment limit, not a product bug.

## Before You Start: Preflight

QA evidence is current-head evidence and the Manual tests checklist is the
body's contract, so anything that would change either runs first. On a large
PR (over 10 files or 300 hand-written lines) that has not had a `refactor`
pass, say so and offer it before driving anything. A refactor landed after
QA means this whole pass runs again. Likewise `cold-read` on the PR body
comes before QA, so the checklist you execute is the one the reader will see.

Before spending a long QA pass, verify the PR is in a testable state. Pass
the identified PR number or URL to every `gh pr view` call (bare `gh pr view`
defaults to the current branch's PR, which may differ from the test target):

- **Mergeability.** Check `gh pr view <PR> --json mergeable,mergeStateStatus`.
  A conflicting PR may get no gating CI run at all, and QA evidence against a
  conflicting head is evidence against code that will change on merge. If
  conflicting, report blocked rather than driving.
- **Head SHA incorporated.** Confirm the PR's `headRefOid` is part of the
  tested state (`gh pr view <PR> --json headRefOid`). When testing companion
  PRs together, the local HEAD may be a merge commit that incorporates
  multiple PR heads; verify the target PR's head is in the ancestry
  (`git merge-base --is-ancestor <headRefOid> HEAD`) and record the composite
  SHA rather than requiring an exact match. A checkout that does not contain
  the PR head produces evidence for code the reviewer is not looking at.
- **CI existence.** Check whether at least one workflow run exists for the
  PR's head commit (`gh run list --commit <headRefOid>`). If the repo has CI
  and no run registered, something is wrong (path filters, a conflicting
  state, a workflow syntax error). Note it; do not assume the code is healthy.
- **Tools alive.** Verify every tool the run will need before the first long
  flow: authenticated CLIs, running services, connectors, test-mode keys.
  A flow that dies at step 7 for a missing login wastes the entire run.
