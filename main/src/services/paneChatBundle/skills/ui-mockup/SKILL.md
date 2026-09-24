---
name: ui-mockup
description: Create three UI mockup options per round, then refine the user's favorite until they approve one. Works from screenshots of the current product or from agreed references for something new, with whatever tools are available (an image model, HTML/CSS in a browser, or a wireframe). Use for "mock this up," "UI mockup," or "show me what this would look like" for interfaces. Saves the approved design with the ticket or brief.
---

# UI mockup

Show the person what an interface could look like before anyone builds it.
Match the product's visual language when there is a product, and make every
option easy to compare.

## Start from what exists

- **Existing product:** reuse screenshots you have, or capture them. When no
  specific user state is needed, run the app or open an accessible page and
  capture with the browser or app tools available (for example Playwright),
  following the repository's setup notes. Ask for screenshots when the screen
  or state can't be reached.
- **Something new:** agree on references first (products, sketches, a style
  to follow), and label the result as a new concept.
- Pin down the screen, the state, what changes, and what must stay the same.
  Ask about gaps that change the design; decide the rest yourself.

## Pick the medium

Use the most faithful medium you have, and say which one you used:

1. **An image model with editing** (edits a screenshot, or generates from
   references): best for changes to an existing screen. Read its prompting
   guidance first. Get the person's agreement before using a paid API.
2. **HTML and CSS in a browser:** always available where a browser is. Rebuild
   the relevant part of the screen with the product's fonts, colors, spacing,
   and components, render it, and screenshot it. Good for layout and copy
   changes, and the result is closer to what gets built.
3. **A wireframe** (ASCII or a quick SVG): for early structure questions when
   fidelity doesn't matter yet.

The same steps apply to every medium.

## Three options per round

- State the change and the exact labels and copy. Keep layout, dimensions,
  theme, typography, density, icons, and untouched regions as they are unless
  the option is about them. Mark each input as an edit target or a style
  reference.
- Make three distinct options: design directions in the first round, then
  refinements of the favorite. Label them 1 to 3.
- Check each option for garbled text, changed regions that should have stayed,
  and anything that couldn't really be built. Open all three for the person;
  if opening fails, show them inline with file links, and note any fidelity
  limits.
- Ask for a favorite and feedback, and use the favorite as the next round's
  starting point. Keep the original screenshots, earlier options, and the
  things that must stay the same. A favorite guides the next round; only
  explicit approval makes a design final.

## Save the approved design

- Save it where the work lives: with the ticket or brief (see `create-ticket`
  and `brief`), in Grain when it's connected, or in the page bundle (see
  `page`) otherwise. Honor local-only and draft-only requests. A standalone
  mockup stays local.
- Save the approved image with a caption, version, and approval status. Keep
  the prompts or source, the references, and the earlier options, marked as
  drafts or rejected.
- Bring the approved decisions into the ticket or brief: align scope and
  acceptance criteria with the design, and treat incidental details in the
  image as illustration.
- Match the audience: keep private artifacts private, and get authorization
  before sharing anything publicly.
- Check that images and links render, then return them. If a save or upload
  fails, keep the local files and report their paths and what is still
  outstanding.
