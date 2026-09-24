# Bundles and destinations

Every piece of work has one bundle: a folder holding all the pages written for a person. What a bundle is never changes. Where it is published can.

## The bundle

```
<root>/<slug>/
  index.html           the brief. It is the hub, so opening the folder lands on it
  options.html
  plan.html            the approved plan, when it is written as a page (often it is the ticket)
  trace.html           conversation viewer, when one is requested
  post-mortem.html     retrospective, when implementation work ends
  explainers/<topic>.html
  mockups/<screen>-v<n>-<option>.html     or .png
  evidence/            screenshots and recordings
  bundle.json
```

- `<slug>` is a short kebab-case name for the work, the same one used for the branch.
- Link between documents with relative links only (`options.html#decision-1`, `explainers/queue.html`). A bundle must work unchanged when it is opened from disk, zipped, copied, or published somewhere else.
- Every brief and plan page has a visible **Contents & related files** navigation near the top:
  - Section anchor links, and a table of every other existing bundle file, including supporting evidence and `bundle.json`, each with its linked filename or title and its purpose. For a large evidence collection, link an evidence index that lists each file.
  - Update it, and the document list in `bundle.json`, as files are added. Check local targets and anchors before publishing.
  - Link only files that already exist. If there are none yet, say so.
  - Each related document links back to `index.html`.
- An explainer written before any brief exists gets its own bundle, and is moved in and linked when the brief appears.
- Create documents only when needed. When a trace or post-mortem exists, link it from the hub and the plan's contents, and list it in `bundle.json`. A requested `trace.html` that has not been captured yet says plainly that capture is pending or unavailable.
- When the plan is a page, `plan.html` is the one plan read by the person and by the sessions that implement and review it. It carries the outcome, scope, locked decisions, how we will know it works, and links the approved design. When the plan lives elsewhere (a ticket, a markdown file), link it from the hub instead.

`bundle.json` is how a later session, or an orchestrator, finds and updates the same bundle instead of making a second one:

```json
{
  "slug": "scheduled-texts",
  "title": "Scheduled texts",
  "status": "draft | ready for options | ready for plan | approved | in build | done",
  "documents": ["index.html", "options.html", "explainers/sending-pipeline.html"],
  "destination": "local",
  "published": { "kind": null, "id": null, "url": null },
  "updated": "<ISO 8601 time>"
}
```

## Where it goes

Work out the destination once, in this order, and record it in `bundle.json`:

1. What the person says in this conversation
2. A destination named in the task or launch context
3. A standing preference in the workspace instructions or the target repository's own conventions
4. Otherwise `local`

`local` means `<root>` is `tmp/pages/` in the project you were started in. Check that `tmp/` is git-ignored, and never commit a bundle unless the person asks for it to live in the repository. If the destination is a path, that path is `<root>`.

## Publishing somewhere else

A named destination, such as a document workspace, a wiki, or a shared drive, is a place you publish a copy to. The local bundle stays the working copy.

1. Build or update the bundle locally first.
2. Publish it with the tools this session has for that destination, following that destination's own skill or documentation. Keep the folder structure and the relative links. One piece of work maps to one container there (one workspace, one folder, one page tree).
3. If `bundle.json` already has a `published.id`, update that same container. Never create a second one. If you are unsure whether an earlier publish succeeded, look before retrying.
4. Private by default. Never widen who can see it unless the person asks.
5. Read back what you published, then record its `kind`, `id`, and `url` in `bundle.json`.
6. If the destination cannot hold several linked files, publish `index.html` with the other documents' content reachable from it as best the destination allows, and say what was lost.
7. If the tools are missing or publishing fails, say so plainly, keep working from the local bundle, and give its path. Never claim something was published that was not.

Give the person the published link when there is one, and the local path otherwise.

## Session telemetry in the same artifact

When the workspace or person requests telemetry evidence, use the workspace's
collection and export instructions. Include only sessions associated with this
work and their relevant descendants.
Keep the evidence under `evidence/telemetry/`, preserve its provenance and
completeness metadata in `bundle.json`, and publish it with the other bundle files
to the same existing container.

Collection, export commands, provider configuration, and destination-specific
upload procedures come from the project's workspace instructions.
Conversation content requires explicit authorization; even metadata can contain
private paths or tool arguments. Preserve the artifact's audience.

A running session's evidence is a live snapshot. Arrange for
the parent or orchestrator to refresh the evidence and the published bundle after
the associated sessions finish. Distinguish local export from successful upload,
verify the published evidence, and report incomplete snapshots or failures plainly.

## Post-mortem

When implementation ends and a retrospective is wanted, write `post-mortem.html` in the same bundle, following [post-mortem.md](post-mortem.md), and publish it with the updated plan and any trace. Label a blocked or failed ending as blocked or failed. A retrospective written while work continues is an interim snapshot, and the parent refreshes it after the workers finish.

## Conversation viewer

When a trace is requested, the bundle gets a `trace.html` that reads locally, built with [`session-trace`](../../session-trace/SKILL.md). Lead with the user messages and agent replies in order, with clear roles and readable formatting. Tool calls start collapsed and expand independently, so opening a conversation leaves its tool details closed. Keep worker threads separate and easy to reach. Link the viewer prominently from the hub, plan, and post-mortem.

Include only the sessions explicitly identified for this task and its descendants. Respect conversation-capture authorization and the destination's audience: an explicit request for a conversation viewer authorizes that scope only, and unrelated history or public sharing needs its own authorization. If capture is unauthorized or unavailable, include an honest status page and ask for any permission that is required. Record omissions, redactions, missing workers, and whether the snapshot is final. Never substitute a made-up transcript or internal reasoning for the messages users saw.
