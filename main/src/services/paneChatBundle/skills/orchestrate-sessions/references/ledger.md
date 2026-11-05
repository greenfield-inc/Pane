# Ledger

Use host durable state when available; otherwise `.agent/ledger.json`. Keep one entry per work item. Host IDs are opaque and separate from `status_file`; record associations only as the host reports them.

```json
{
  "caps": { "concurrent": 3, "spend_usd": null },
  "items": [
    {
      "id": "ENG-123",
      "source": "/absolute/bundle/plan.html",
      "urgency": "normal",
      "worktree": "../worktrees/invoice-pdf",
      "branch": "invoice-pdf",
      "role": "planning | implementation | bug-report",
      "agent": "the agent chosen for this item",
      "skills": ["tdd", "verify-app", "prepare-pr"],
      "status_file": "../worktrees/invoice-pdf/.agent/status.json",
      "stage": "queued | running | blocked | in review | pr open | done | failed | needs planning",
      "started": "<ISO 8601 time>",
      "last_change": "<ISO 8601 time>",
      "host_workspace_id": null,
      "host_worker_id": null,
      "owning_session_id": null,
      "last_event_id": null,
      "phase": "planning | awaiting approval | implementing | complete",
      "source_revision": null,
      "implementation_approval": null,
      "bundle": null,
      "post_mortem": null,
      "trace": null,
      "cost_usd": null,
      "duration_ms": null,
      "pr": null,
      "pr_artifact": "the PR's companion page, from the worker's report",
      "last_reviewed_head": "sha of the head the last review covered, or null",
      "depends_on": [],
      "front_page": "the brief (index.html of the bundle) for a planned item, or session/items/<item>.html (item-hub.md)",
      "next": "the item's next step and who takes it, shown on its card",
      "blocker": null
    }
  ],
  "decisions": [
    {
      "time": "<ISO 8601 time>",
      "item": "ENG-123",
      "d": "D-12",
      "question": "Should the filename use the invoice id or number?",
      "options": ["Invoice id", "Invoice number"],
      "answered_by": "brief | plan | person",
      "answer": "Invoice id. Brief, Success section."
    }
  ]
}
```
