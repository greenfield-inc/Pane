# Item hub

The front page for a work item that has no bundle: a quick fix, a tweak, or a PR the Session picked up. A planned item's front page is its brief; this page stands in for one. Keep it in the Session folder as `session/items/<item>.html`, follow the [`page`](../../page/SKILL.md) standard, and link it from the item's card on the status page.

```
Title          the item's name
Summary        a three-line summary: what was asked (the person's words), what changed,
               and where it stands
Stage          the item's stage, its PR's checks, QA and review state, and
               "Next: <the item's next step and who takes it>"
Contents       one row per related file, each linked with its purpose, as it exists:
               task       the starting message or request it came from
               PR         the pull request, and the PR's companion page
               findings   the review findings file, when it was reviewed
               post-mortem   when one was written, or "no issues hit" once it closed cleanly
               trace      the conversation viewer, or why it is missing
Back           a link to the status page (../index.html)
```

Link only files that exist; until there are any, say so. Update the hub when the item's stage changes, and check its local links after writing it.
