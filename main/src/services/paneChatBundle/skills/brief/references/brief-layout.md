# Brief layout

An HTML page. Lead with the problem and a picture of it, not with metadata.

```
Header          title, one-line summary, status chip:
                draft | socrates: pass | ready for options | ready for plan

Contents        linked table of contents for sections and related bundle files
The problem     one plain paragraph, with no solution in it
Who it affects  users and the situation they are in
Today / Wanted  side by side: a screenshot, a diagram, or a short story of each
Success         what a user can do afterwards, observably
Constraints     a short list, in its own full-width section
Non-goals       a separate full-width section immediately below Constraints
Unknowns        facts we lack
Open decisions  named, not chosen: "cron vs queue vs provider".
                Link each to its section in the options document once that exists
                Behaviour a reference product has settled may appear above it as
                "Proposed behaviour" (pattern, source, proposal); approaches never do
Evidence        screenshots, quotes, links, the bug report if there is one.
                Attribute reports. Mark what is suspected rather than known
Sources         the discussion, issue, or document each requirement came from
Related         every other document for this work, as it appears: explainers,
                options, mock-ups, spikes, the plan, the pull request
Footer          origin (explain | chat | bug), linked issue, and a change log,
                newest first: what changed, why, and what it superseded
```

Constraints and Non-goals stay stacked vertically, each full width, at every viewport width. Every brief includes the linked contents and related-files navigation described in [`../../page/references/bundle.md`](../../page/references/bundle.md), updated as files are added.

The issue body, when there is one, carries: the problem, who it affects, success, constraints and non-goals, open decisions, and the link to this page.
