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
      "blocker": null
    }
  ],
  "decisions": [
    {
      "time": "<ISO 8601 time>",
      "item": "ENG-123",
      "question": "Should the filename use the invoice id or number?",
      "answered_by": "brief | plan | person",
      "answer": "Invoice id. Brief, Success section."
    }
  ]
}
```
