---
name: babysit-pr
description: Use after a pull request is open to watch its CI and review-bot comments until it is ready. Fixes real findings, replies with a reason to false positives, rebases when the base moves, and stops when bots and required checks are green. Merges only when the person asked.
---

# Babysit PR

Most repositories run AI review bots and CI on every pull request. They are helpful, even when they are not right.

Run it once the PR is open, when the person says "ready", or when your own instructions say to.

## Watch

Match the effort to the change: a docs-only or few-line PR skips the watching below and the green-checks condition under Stop, and reports as soon as it's open.

Watch the PR instead of checking once. In Claude Code, run `gh pr checks <pr> --watch` in the background or use a monitor, so you respond when checks or comments arrive. In Codex, or wherever nothing can wake you, poll `gh pr checks <pr>` and the review threads every few minutes.

Only act on checks and comments newer than the latest push. Compare their timestamps with the head commit:

```bash
gh pr view <pr> --json headRefOid,commits,statusCheckRollup,reviews,comments
```

Review threads, and whether they are resolved, come from GraphQL:

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(last:1){nodes{author{login} body createdAt path line}}}}}}}' -f o=<owner> -f r=<repo> -F n=<pr>
```

## Act

Verify every bot finding against the source before changing code. Fix real findings and CI failures. Tell repository failures apart from infrastructure flakes; rerun a flake once with `gh run rerun <run-id> --failed` before treating it as real.

If a review bot leaves feedback that is not worth addressing, reply with a written reason and resolve the thread:

```bash
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread-id>
```

Every reply is posted under the person's account. Write it the way they would: short, specific, and without filler.

Screenshots and videos help reviewers. Host them where the repository's workflow says (the document destination your workspace instructions name, or a release asset, for example) and link them. Never commit evidence files.

Keep an eye on the base branch and rebase when needed. If an overlapping PR makes this one obsolete, stop monitoring, tell the person, and ask before closing it unless closing was explicitly authorized.

Fix every finding within the PR's goal, including small in-scope improvements a reviewer or bot raises; don't dismiss an in-scope finding as out of scope. For a suggestion beyond the goal, don't grow the PR: capture it with [create-ticket](../create-ticket/SKILL.md) (or in the PR's findings or handoff file when ticket creation isn't authorized) and reply on the thread with the link. When you decline a finding as wrong, reply with the reason.

## Stop

If nothing has changed, stay quiet rather than posting filler comments. Stop when the review bots and required checks are green on the latest commit. Merge only when the person explicitly asked for it; otherwise report that the PR is ready.
