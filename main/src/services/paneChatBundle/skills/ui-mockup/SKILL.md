---
name: ui-mockup
description: Create three UI mockup options per round, then refine the person's favourite into the approved design reference. Works from screenshots of the current product or from agreed references for something new, with whatever tools are available (an image model, HTML and CSS in a browser, or a wireframe). Use for "mock this up," "UI mockup," or "show me what this would look like" before an interface is built. Saves the approved design with the ticket, brief or plan.
---

# UI mockup

A mock-up settles what the interface should look like before anyone plans or builds it. Match the product's visual language when there is a product, and make every option easy to compare. The approved result becomes the design reference that `visual` checks are judged against.

## Start from what exists

- **Existing product:** reuse screenshots the person gives you, or capture them yourself: when specific user state is unnecessary, launch the dev build or open an accessible environment and capture the screens with browser tools, following the repository's setup guidance. Ask for screenshots when the screen or state is out of reach.
- **Something new:** agree on the references to match first (products, sketches, a style to follow), and label the result as a new concept.
- Inspect a small reference set for layout, theme, type and components.
- Agree on the screen, the state, what changes, and what must be preserved. Ask about gaps that change the design; decide the rest yourself.

## Pick the medium

Use the most faithful medium you have, and say which one you used:

- **Images**, only when you have an image generation tool yourself, for exploring looks quickly or changing an existing screen: edit the real screenshots with it, one call per option. Generate from scratch only for a new screen from agreed references. Read the tool's prompting guidance first.
- **HTML and CSS in a browser**, when exact text, real data, responsive behaviour, or a pixel comparison later matters, and whenever you have no image tool: rebuild the screen from the product's real components, styles, icons and fonts, matching its layout, type, spacing, colours, and density. Render it and screenshot it. The result can be opened, resized, and compared against a screenshot.
- **A wireframe** (ASCII or a quick SVG), for early structure questions when fidelity doesn't matter yet.
- The approved design that `visual` checks are judged against should be exact. If the approved option is a generated image with invented details, either rebuild it in HTML or list which details are illustrative.
- Ask before using any paid API or paid fallback.

## Three options per round

- State the change and the exact labels and copy. Change only what is in scope: keep layout, dimensions, theme, typography, density, icons, and untouched regions unless the option is about them. Mark each input as an edit target or a style reference.
- Make three distinct options: design directions in the first round, then refinements of the favourite. Label them 1 to 3.
- Check each option for garbled text, regions that changed but should have stayed, and anything that couldn't really be built. Open all three for the person (inside Pane, `runpane panels open --file <path> --source agent --yes`); if opening fails, share them as file links. Note any fidelity limits.
- Ask for a favourite and feedback, and use the favourite as the next round's starting point. Keep the original screenshots, earlier options, and the things that must stay the same.

## Approval and saving

- A favourite guides the next round. Only an explicit approval selects the final design.
- Save the approved design under `mockups/` in the work's page bundle (see [`page`](../page/SKILL.md)), or with the ticket or brief (see [`create-ticket`](../create-ticket/SKILL.md) and [`brief`](../brief/SKILL.md)), with a caption, version, and approval status. Keep rejected options marked as rejected, and keep the prompts or source and the references.
- Honour local-only and draft-only requests; a standalone mockup stays local. Never widen who can see it without authorization.
- Record it in the brief under Evidence. When a plan follows (the ticket from `create-ticket`, or `plan.html`), it becomes the plan's design reference, with the list of screens that must match it.
- Details that the mock-up invented and nobody discussed are illustrations, not requirements. Say which are which.
- Check that images and links render, then return their paths or links. If a save or upload fails, keep the local files and report what is outstanding.

## Banned

- Changing source code to produce a mock-up
- Presenting a mock-up as approved when the person only picked a favourite
