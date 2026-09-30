# Decision framing: worked example

The rule itself is **Presenting decisions** in [the orchestrate-sessions skill](../SKILL.md). This page shows it applied to a real decision that went wrong. Postmortem: [The upload sweeper we didn't need](https://rungrain.com/w/WxLWDabvA7vIibrQNj_yZ).

## Context

A messaging app gained background video uploads. The bytes keep uploading after the app is closed, but the final "complete and post" step was a command sent by the app over its live connection. A closed app can't send it. The planning session's design added a server job that ran every 30 seconds and posted the message for the user.

## Before: what was relayed

> 1. May the server post the message on the sender's behalf after the app is killed? [yes, like iMessage]
> 2. Cap uploads at 2 GB? [yes]
> 3. Allow uploads over cellular? [yes]
> …nine items in all

The user approved the batch. What went wrong:

- A product decision (the server acting for the user) sat as item 1 of nine technical yes/no questions.
- There was one option. The simpler mechanism, the phone finishing the send itself, was never listed.
- Nothing said what the sweeper would cost: a background job, claim and takeover logic, a schema column.
- The analogy was false. iMessage, WhatsApp and Signal finish the send on the phone and show "Not Delivered" when they can't. The server doesn't post for you.
- The orchestrator added the analogy and relayed the planner's premise ("only the server is still running") without checking it.

## After: what should have been relayed

> **Product decision: who finishes a send when the app is closed mid-upload?** (Asked separately from the technical items below.)
>
> **A. The phone finishes it (recommended).** When the bytes land, the native background upload calls "complete" itself with a single-use token. If that fails after retries, the message shows "Not sent · Tap to retry" and a local notification appears.
> - *Users:* the video sends without reopening the app in the normal case. In rare failures they see "Not sent" and tap to retry.
> - *Engineering:* one HTTP endpoint and native retry code. No background job, and no schema beyond the upload record both options need. A daily cleanup deletes uploads that were never sent.
> - *Prior art:* iMessage, WhatsApp and Signal send from the device and show a failed-send state with retry. Verified: {link to each app's help page or a checked device}.
>
> **B. A server sweeper posts it.** A job runs every 30 seconds, finds finished uploads with no send, and posts the message as the user.
> - *Users:* the message always posts eventually, including after a failure the user never saw. The server now acts on their behalf.
> - *Engineering:* a new background job on every host, claim and takeover logic, a schema column, and ongoing tuning of its interval and load.
> - *Prior art:* none of the three above does this; other apps unverified.
>
> **C. Do nothing.** Sends complete only while the app is open. A closed app leaves the upload unsent until the next launch, with no signal to the user. No new engineering, but the silent failure stays.
>
> **Recommendation: A.** It matches how users expect messengers to behave, adds no background machinery, and keeps the server from posting for anyone. You accept that a rare failed send needs a tap to retry.
>
> **Premise checked:** the plan assumed only the server could complete the send. The native upload code can call the endpoint itself, which is what makes A possible.
