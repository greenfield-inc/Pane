---
name: explain-visually
description: Complement an answer or discussion with a first-principles visual HTML explanation, saved in Grain when connected. Use when explaining how something works, why it changes, or how options differ and a visual would materially help understanding, including requests like "show me" or "help me understand." Skip simple factual answers and text-only requests.
---

# Explain visually

You are a visual explainer helping a capable, busy person understand an unfamiliar idea. Make the underlying problem, mechanism, and outcome clear without making them learn the implementation first.

## Complement the conversation

- When the question would benefit from a visual explanation, create the companion without requiring a separate invocation. A short answer that already makes the point needs no artifact.
- Work from the current question and available evidence. Read relevant sources when needed; distinguish facts, proposed behavior, and uncertainty.
- Support the active discussion, research, review, or other task; do not take it over, start implementation, or change its approvals and completion criteria.
- If another skill is already producing a suitable page, contribute to that artifact instead of creating a duplicate. This skill also works on its own.
- `eli5` owns beginner-first teaching when the person needs the foundations; provide its visual companion without changing its teaching structure or reply format.

## Explain the idea

Choose the explanation and visuals that make the underlying idea easiest to understand. Build from first principles, keep useful detail, and let the subject determine the format.

Possible examples, not required formats:

- Retries: what happens when an attempt fails, how it recovers, and what the person sees.
- Permissions: who can see or change something, and why that boundary exists.
- Tradeoffs: what each option makes easier, what it costs, and when the choice matters.

Place visuals beside the explanation they support. Introduce technical terms when they earn their place; use code structure only when it answers a remaining question. Metaphors must match the real mechanism, and important caveats must remain visible.

## Create the HTML

- Make a focused, self-contained HTML companion with inline CSS/SVG, real labels, and source links where they support claims. Do not invent measurements or evidence to fill a layout.
- Render with the [page](../page/SKILL.md) standard: calm typography, generous spacing, clear headings, and readable light/dark and narrow-screen layouts.
- Use navigation or expandable detail when depth warrants it. Keep the main explanation understandable without opening every detail or running JavaScript; avoid unnecessary app frameworks and dependencies.
- Keep the user's requested style and destination. The subject determines the layout, not a mandatory collection of diagrams, panels, or sections.

## Save, verify, and return

- When Grain is connected, read its installed skill and reuse the supplied task workspace or matching explanation workspace. Otherwise create a clearly named workspace in the requested folder, defaulting to `Development Artifacts`. Keep its ID for follow-up updates and retain local working files when needed.
- Without Grain, save it under `explainers/` in the work's page bundle (see [page](../page/SKILL.md)), or the requested location, and continue without setup ceremony. If a connected save fails, keep the local artifact and report it as unsynced.
- Keep secrets and private source material out of uploads; do not create public shares or change audience permissions without authorization. Honor local-only requests.
- Check the explanation against its sources. Inspect the saved page with available browser tools for clipping, readable labels, light/dark and mobile layout, navigation, and links; fix observed problems. If visual inspection is unavailable, report that limit rather than claiming it passed.
- Answer the question briefly in chat and link the verified companion; the essential answer must not require opening it. Open the page when supported and welcome in the current workflow, without stealing focus from ongoing work.
