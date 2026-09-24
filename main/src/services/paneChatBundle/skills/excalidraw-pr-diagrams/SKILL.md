---
name: excalidraw-pr-diagrams
description: Create Excalidraw diagram JSON files and PR visual overviews that make visual arguments. Use when the user wants to visualize workflows, architectures, concepts, pull request changes, before/after behavior, or a shareable explainer image for reviewers.
---

# Excalidraw Diagram Creator

Generate `.excalidraw` JSON files that **argue visually**, not just display information.

**Setup:** If the user asks you to set up this skill (renderer, dependencies, etc.), see `README.md` for instructions.

## Local Codex or Claude PR Workflow

When using this skill for pull request diagrams in Codex or Claude:

- Always create and edit diagram working files in a temporary working directory outside the target repo, preferably `/tmp/codex-pr-diagrams/<repo-or-pr>/` or `C:\tmp\codex-pr-diagrams\<repo-or-pr>\`.
- Do not create generated `.excalidraw`, `.png`, or temporary render files inside the repository unless the user explicitly asks for tracked diagram assets.
- For PR descriptions, use the rendered Excalidraw image as the primary visual. Do not add Mermaid diagrams by default; they are usually redundant once the Excalidraw image includes before/after flow and reviewer explainers. Add Mermaid only if the user explicitly asks for a durable text-rendered fallback.
- Save matching `.excalidraw` source files under `/tmp` for local iteration and future reuse.
- PR visual overviews must include explicit `Before` and `After` diagrams so reviewers can see both the old behavior and the new behavior without inferring the diff from prose.
- Keep each PR diagram focused on the change boundary: before, after, and why the new flow is safer.
- After generating diagrams, update the PR description with a dedicated `## Visual Overview` section.

### PR Asset Publishing

Default: PR images are **hosted, not committed**. Prefer a repository-owned
durable asset surface. For GitHub PRs, discover and reuse a published, mutable,
long-lived release such as `pr-assets`; inspect it with `gh release list` and
`gh release view <tag> --json tagName,isDraft,isPrerelease,isImmutable,url,assets`.
Do not create a new release per PR, and do not use an arbitrary temporary host
when a suitable repository release exists.

If no suitable release exists, creating one dedicated long-lived `pr-assets`
release is a separate hard stop requiring an exact grant such as
`{"action":"create_release","repo":"owner/name","tag":"pr-assets"}`. Generic
GitHub, PR, comment, or asset-upload authorization does not grant creation.
Target the default branch, use `--latest=false`, and explain in its notes that it
stores long-lived PR/QA images. If creation or
upload is not authorized, keep the render local and prepare the exact release
creation/upload commands, manifest, and marked PR Markdown; report durable
publication as blocked instead of falling back to a temporary host.

Before upload, calculate the PNG SHA-256 and use a portable name such as
`pr-<number>-<head-short-sha>-<content-sha12>-visual-overview.png`; use a branch
slug before a PR number exists. Make publishing idempotent by inspecting
existing assets first. Reuse an exact
name only when its GitHub digest, or a downloaded hash when the digest is
absent, matches. On different content, extend the digest or add a deterministic
suffix and upload a new name. Never use `--clobber`: replacing an asset can
silently change images embedded in older PRs.

After `gh release upload`, read back the release and asset metadata. Verify the
tag, non-draft release, uploaded state, filename, size, digest when present, and
browser download URL. Perform a direct GET of the bytes (authenticated for a
private repository), compare SHA-256 and size with the local render, and verify
the decoded file type or image magic so an HTML error page cannot pass.

Maintain a local `pr-assets-manifest.json` with repository, release tag and URL,
PR number, head commit, source/render paths, asset name, SHA-256, size, asset API
and browser URLs, upload-or-reuse status, timestamp, and content-verification
result. Never put credentials or sensitive source material in the manifest.

Commit the image only when it is embedded in tracked docs (a README, design
doc) that needs a stable in-repo path, then `.github/pr-assets/` or
`docs/`, referenced with a blob URL + `?raw=1`, e.g.
`https://github.com/<owner>/<repo>/blob/<branch>/.github/pr-assets/<image>.png?raw=1`.
Keep `.excalidraw` sources outside the repo unless the user asks to track them.

Either way:

- After updating, open or fetch the image URL. A PR visual with a 404 image is a failed handoff.
- Embed the verified image inline inside a `## Visual Overview` PR body/comment section bounded by `<!-- pr-visual-overview:start -->` and `<!-- pr-visual-overview:end -->`. Replace dead, expiring, temporary, or local-only references on rerun. Update only the marked section and preserve author text; for a broken image outside a marker, replace only the URL after verifying the intended asset.
- Read back or preview the PR body/comment after updating it. Markdown that collapses bullets, headings, or the image into one paragraph is a failed handoff.

### PR Diagram Standard

For PR diagrams, a simple pair of red/green cards is not acceptable. The diagram must teach the change in a way prose cannot.

Before drawing, identify the visual truth of the PR:

- **Boundary changed**: draw walls, membranes, trust zones, or origin/process boundaries.
- **Lifecycle changed**: draw a state machine, gate sequence, or retry loop.
- **Responsibility moved**: draw before/after ownership regions and move the action across them.
- **Failure mode removed**: draw the old failure path visibly dead-ending and the new path avoiding it.
- **Concurrency/race fixed**: draw clocks, timelines, joins, or retry circuits.
- **Validation/permissions changed**: draw a decision path, lock/gate, and what passes through it.

Every PR visual overview must include:

- A **before path** showing where the old system failed or was fragile.
- An **after path** showing the new route/control point.
- At least one **semantic visual structure**: boundary, timeline, loop, funnel, state machine, swimlane, queue, fan-out, convergence, or layered stack.
- One short **truth statement** that explains the visual argument in plain language.
- A small **term explainer** when the diagram uses protocol/framework words that a reviewer may not know. Do not assume terms like header, preflight, origin, token, cookie, CORS, WebSocket upgrade, cache key, breakpoint, or trace are self-explanatory.

Do not use the same diagram structure for a series of PRs unless the code changes truly have the same shape. Split PRs usually need different visual metaphors because they fix different kinds of problems.

### Shareable Explainers

When the user wants a PR image that can teach the change to someone else, design it as a shareable explainer, not just reviewer decoration.

- Make the title state the strategic outcome, not the implementation detail.
- Show the old blind spot, failure mode, or uncertainty on the left.
- Show the new loop, boundary, path, or control point on the right.
- Include at least one concrete example input and one concrete output. Real event names, endpoint paths, page names, source URLs, or dashboard fields make the image feel authoritative.
- If measurement is part of the value, show what gets captured and how it becomes a decision, backlog item, or next action.
- Add enough whitespace that each box can breathe. If an arrow needs to loop back, route it around the outside of the boxes.
- Inspect the final image at the size GitHub shows in a PR. If the viewer must open the image full size to understand it, simplify the diagram.

### Reviewer Explainers

When a PR involves technical protocol behavior, include a compact teaching layer in the visual:

- Define the technical noun in a concrete metaphor before using it. Example: `headers = extra notes the browser wants to attach`, `preflight = permission check before the real request`, `origin = website address the browser trusts or blocks`.
- Show who performs each action. Example: `Browser asks`, `API answers`, `Browser blocks`, not just `headers requested`.
- Use concrete examples sparingly: `login badge`, `Sentry trace`, `Firebase app id` is clearer than a long raw header list.
- Keep the official term visible in parentheses after the plain-English term when useful: `permission check (CORS preflight)`.
- If the diagram has a metaphor, keep it mapped to the real system with labels. A security desk can teach CORS, but the browser/API roles must remain visible.

For review diagrams, assume the reader is smart but has not learned this subsystem yet. If the reader would ask "who does that?" or "what is that?", add a visual cue or one-line explainer instead of relying on the PR prose.

## Customization

**All colors and brand-specific styles live in one file:** `references/color-palette.md`. Read it before generating any diagram and use it as the single source of truth for all color choices: shape fills, strokes, text colors, evidence artifact backgrounds, everything.

To make this skill produce diagrams in your own brand style, edit `color-palette.md`. Everything else in this file is universal design methodology and Excalidraw best practices.

---

## Core Philosophy

**Diagrams should ARGUE, not DISPLAY.**

A diagram isn't formatted text. It's a visual argument that shows relationships, causality, and flow that words alone can't express. The shape should BE the meaning.

**The Isomorphism Test**: If you removed all text, would the structure alone communicate the concept? If not, redesign.

**The Education Test**: Could someone learn something concrete from this diagram, or does it just label boxes? A good diagram teaches: it shows actual formats, real event names, concrete examples.

**The Redundancy Test**: If the diagram is just the PR description broken into red and green rectangles, discard it. A good diagram uses spatial relationships, arrows, boundaries, and shape to reveal something the prose does not.

**The High-Schooler Test**: A smart high-schooler should be able to point at the diagram and explain the core before/after change without reading the full PR. If they would only read labels out loud, redesign.

---

## Depth Assessment (Do This First)

Before designing, determine what level of detail this diagram needs:

### Simple/Conceptual Diagrams
Use abstract shapes when:
- Explaining a mental model or philosophy
- The audience doesn't need technical specifics
- The concept IS the abstraction (e.g., "separation of concerns")

### Comprehensive/Technical Diagrams
Use concrete examples when:
- Diagramming a real system, protocol, or architecture
- The diagram will be used to teach or explain (e.g., YouTube video)
- The audience needs to understand what things actually look like
- You're showing how multiple technologies integrate

**For technical diagrams, you MUST include evidence artifacts** (see below).

---

## Research Mandate (For Technical Diagrams)

**Before drawing anything technical, research the actual specifications.**

If you're diagramming a protocol, API, or framework:
1. Look up the actual JSON/data formats
2. Find the real event names, method names, or API endpoints
3. Understand how the pieces actually connect
4. Use real terminology, not generic placeholders

Bad: "Protocol" → "Frontend"
Good: "AG-UI streams events (RUN_STARTED, STATE_DELTA, A2UI_UPDATE)" → "CopilotKit renders via createA2UIMessageRenderer()"

**Research makes diagrams accurate AND educational.**

---

## Evidence Artifacts

Evidence artifacts are concrete examples that prove your diagram is accurate and help viewers learn. Include them in technical diagrams.

**Types of evidence artifacts** (choose what's relevant to your diagram):

| Artifact Type | When to Use | How to Render |
|---------------|-------------|---------------|
| **Code snippets** | APIs, integrations, implementation details | Dark rectangle + syntax-colored text (see color palette for evidence artifact colors) |
| **Data/JSON examples** | Data formats, schemas, payloads | Dark rectangle + colored text (see color palette) |
| **Event/step sequences** | Protocols, workflows, lifecycles | Timeline pattern (line + dots + labels) |
| **UI mockups** | Showing actual output/results | Nested rectangles mimicking real UI |
| **Real input content** | Showing what goes IN to a system | Rectangle with sample content visible |
| **API/method names** | Real function calls, endpoints | Use actual names from docs, not placeholders |

**Example**: For a diagram about a streaming protocol, you might show:
- The actual event names from the spec (not just "Event 1", "Event 2")
- A code snippet showing how to connect
- What the streamed data actually looks like

**Example**: For a diagram about a data transformation pipeline:
- Show sample input data (actual format, not "Input")
- Show sample output data (actual format, not "Output")
- Show intermediate states if relevant

The key principle: **show what things actually look like**, not just what they're called.

---

## Multi-Zoom Architecture

Comprehensive diagrams operate at multiple zoom levels simultaneously. Think of it like a map that shows both the country borders AND the street names.

### Level 1: Summary Flow
A simplified overview showing the full pipeline or process at a glance. Often placed at the top or bottom of the diagram.

*Example*: `Input → Processing → Output` or `Client → Server → Database`

### Level 2: Section Boundaries
Labeled regions that group related components. These create visual "rooms" that help viewers understand what belongs together.

*Example*: Grouping by responsibility (Backend / Frontend), by phase (Setup / Execution / Cleanup), or by team (User / System / External)

### Level 3: Detail Inside Sections
Evidence artifacts, code snippets, and concrete examples within each section. This is where the educational value lives.

*Example*: Inside a "Backend" section, you might show the actual API response format, not just a box labeled "API Response"

**For comprehensive diagrams, aim to include all three levels.** The summary gives context, the sections organize, and the details teach.

### Bad vs Good

| Bad (Displaying) | Good (Arguing) |
|------------------|----------------|
| 5 equal boxes with labels | Each concept has a shape that mirrors its behavior |
| Card grid layout | Visual structure matches conceptual structure |
| Icons decorating text | Shapes that ARE the meaning |
| Same container for everything | Distinct visual vocabulary per concept |
| Everything in a box | Free-floating text with selective containers |
| Red card titled "Before" beside green card titled "After" | A before failure path and an after success path with different routing |
| Repeating the same template across unrelated PRs | Choosing a visual metaphor per PR: boundary, lifecycle, race, permission gate, retry loop |
| Paragraphs pasted into shapes | Short labels plus visual evidence, arrows, gates, and concrete artifacts |

### Hard Anti-Patterns

Never ship these unless the user explicitly asks for a deliberately minimal sketch:

- Two large cards that simply summarize "Before" and "After".
- A diagram whose boxes could be replaced by bullets with no loss of meaning.
- Red/green color as the only source of meaning.
- Multiple PR diagrams with the same layout when the PRs solve different problems.
- Oversized headings that force the rest of the diagram to sprawl.
- Long prose inside Excalidraw text boxes.
- Rendered output where any text, title, arrow, or shape is clipped.
- Rendered output where key content requires horizontal scrolling to understand.

### Simple vs Comprehensive (Know Which You Need)

| Simple Diagram | Comprehensive Diagram |
|----------------|----------------------|
| Generic labels: "Input" → "Process" → "Output" | Specific: shows what the input/output actually looks like |
| Named boxes: "API", "Database", "Client" | Named boxes + examples of actual requests/responses |
| "Events" or "Messages" label | Timeline with real event/message names from the spec |
| "UI" or "Dashboard" rectangle | Mockup showing actual UI elements and content |
| ~30 seconds to explain | ~2-3 minutes of teaching content |
| Viewer learns the structure | Viewer learns the structure AND the details |

**Simple diagrams** are fine for abstract concepts, quick overviews, or when the audience already knows the details. **Comprehensive diagrams** are needed for technical architectures, tutorials, educational content, or when you want the diagram itself to teach.

---

## Container vs. Free-Floating Text

**Not every piece of text needs a shape around it.** Default to free-floating text. Add containers only when they serve a purpose.

| Use a Container When... | Use Free-Floating Text When... |
|------------------------|-------------------------------|
| It's the focal point of a section | It's a label or description |
| It needs visual grouping with other elements | It's supporting detail or metadata |
| Arrows need to connect to it | It describes something nearby |
| The shape itself carries meaning (decision diamond, etc.) | Typography alone creates sufficient hierarchy |
| It represents a distinct "thing" in the system | It's a section title, subtitle, or annotation |

**Typography as hierarchy**: Use font size, weight, and color to create visual hierarchy without boxes. A 28px title doesn't need a rectangle around it.

**The container test**: For each boxed element, ask "Would this work as free-floating text?" If yes, remove the container.

## Canvas, Text, and Fit Rules

Excalidraw text does not wrap exactly like normal HTML. Design for the renderer, not for wishful JSON dimensions.

### Canvas

- Start with a larger canvas than you think you need. For PR diagrams, plan around roughly **1600-2200 px wide** and **900-1400 px tall** before export.
- Use the larger canvas for meaningful spatial structure, not for giant titles or long paragraphs.
- Prefer two or three clear regions over many cramped micro-panels.
- Leave at least **80 px** outer margin and **50 px** between major regions.

### Text

- Keep titles short: ideally under 55 characters.
- Use smaller title type than instinct suggests: **24-30 px** is usually enough.
- Use labels at **14-18 px** and truth statements at **16-20 px**.
- Keep shape labels to **1-4 short lines**. If a label needs more, split it into multiple nearby annotations or make the diagram itself carry more meaning.
- Manually insert line breaks. Do not rely on Excalidraw/renderer wrapping.
- Make text boxes wider than the text appears to need. Add at least **30-50% extra width** as a safety margin.
- For every text element, set `width` and `height` generously. Clipping is a hard failure.

### Render Fit

After rendering, inspect at the exact PNG that will be shown in the PR:

- If anything is clipped, increase canvas space or shrink/reposition text.
- If the diagram is mostly text, remove prose and add visual structure.
- If the title dominates the image, shrink it.
- If labels overlap arrows or shapes, move labels out of the flow path.
- If the image is too wide to understand in GitHub, reduce prose and stack regions vertically.

---

## Design Process (Do This BEFORE Generating JSON)

### Step 0: Assess Depth Required
Before anything else, determine if this needs to be:
- **Simple/Conceptual**: Abstract shapes, labels, relationships (mental models, philosophies)
- **Comprehensive/Technical**: Concrete examples, code snippets, real data (systems, architectures, tutorials)

**If comprehensive**: Do research first. Look up actual specs, formats, event names, APIs.

### Step 1: Understand Deeply
Read the content. For each concept, ask:
- What does this concept **DO**? (not what IS it)
- What relationships exist between concepts?
- What's the core transformation or flow?
- **What would someone need to SEE to understand this?** (not just read about)

### Step 2: Map Concepts to Patterns
For each concept, find the visual pattern that mirrors its behavior:

| If the concept... | Use this pattern |
|-------------------|------------------|
| Spawns multiple outputs | **Fan-out** (radial arrows from center) |
| Combines inputs into one | **Convergence** (funnel, arrows merging) |
| Has hierarchy/nesting | **Tree** (lines + free-floating text) |
| Is a sequence of steps | **Timeline** (line + dots + free-floating labels) |
| Loops or improves continuously | **Spiral/Cycle** (arrow returning to start) |
| Is an abstract state or context | **Cloud** (overlapping ellipses) |
| Transforms input to output | **Assembly line** (before → process → after) |
| Compares two things | **Side-by-side** (parallel with contrast) |
| Separates into phases | **Gap/Break** (visual separation between sections) |

### Step 3: Ensure Variety
For multi-concept diagrams: **each major concept must use a different visual pattern**. No uniform cards or grids.

### Step 4: Sketch the Flow
Before JSON, mentally trace how the eye moves through the diagram. There should be a clear visual story.

### Step 5: Generate JSON
Only now create the Excalidraw elements. **See below for how to handle large diagrams.**

### Step 6: Render & Validate (MANDATORY)
After generating the JSON, you MUST run the render-view-fix loop until the diagram looks right. This is not optional. See the **Render & Validate** section below for the full process.

---

## Large / Comprehensive Diagram Strategy

**For comprehensive or technical diagrams, you MUST build the JSON one section at a time.** Do NOT attempt to generate the entire file in a single pass. This is a hard constraint: Claude Code has a ~32,000 token output limit per response, and a comprehensive diagram easily exceeds that in one shot. Even if it didn't, generating everything at once leads to worse quality. Section-by-section is better in every way.

### The Section-by-Section Workflow

**Phase 1: Build each section**

1. **Create the base file** with the JSON wrapper (`type`, `version`, `appState`, `files`) and the first section of elements.
2. **Add one section per edit.** Each section gets its own dedicated pass. Take your time with it. Think carefully about the layout, spacing, and how this section connects to what's already there.
3. **Use descriptive string IDs** (e.g., `"trigger_rect"`, `"arrow_fan_left"`) so cross-section references are readable.
4. **Namespace seeds by section** (e.g., section 1 uses 100xxx, section 2 uses 200xxx) to avoid collisions.
5. **Update cross-section bindings** as you go. When a new section's element needs to bind to an element from a previous section (e.g., an arrow connecting sections), edit the earlier element's `boundElements` array at the same time.

**Phase 2: Review the whole**

After all sections are in place, read through the complete JSON and check:
- Are cross-section arrows bound correctly on both ends?
- Is the overall spacing balanced, or are some sections cramped while others have too much whitespace?
- Do IDs and bindings all reference elements that actually exist?

Fix any alignment or binding issues before rendering.

**Phase 3: Render & validate**

Now run the render-view-fix loop from the Render & Validate section. This is where you'll catch visual issues that aren't obvious from JSON: overlaps, clipping, imbalanced composition.

### Section Boundaries

Plan your sections around natural visual groupings from the diagram plan. A typical large diagram might split into:

- **Section 1**: Entry point / trigger
- **Section 2**: First decision or routing
- **Section 3**: Main content (hero section, which may be the largest single section)
- **Section 4-N**: Remaining phases, outputs, etc.

Each section should be independently understandable: its elements, internal arrows, and any cross-references to adjacent sections.

### What NOT to Do

- **Don't generate the entire diagram in one response.** You will hit the output token limit and produce truncated, broken JSON. Even if the diagram is small enough to fit, splitting into sections produces better results.
- **Don't use a coding agent** to generate the JSON. The agent won't have sufficient context about the skill's rules, and the coordination overhead negates any benefit.
- **Don't write a Python generator script.** The templating and coordinate math seem helpful but introduce a layer of indirection that makes debugging harder. Hand-crafted JSON with descriptive IDs is more maintainable.

---

## Visual Pattern Library

### Fan-Out (One-to-Many)
Central element with arrows radiating to multiple targets. Use for: sources, PRDs, root causes, central hubs.
```
        ○
       ↗
  □ → ○
       ↘
        ○
```

### Convergence (Many-to-One)
Multiple inputs merging through arrows to single output. Use for: aggregation, funnels, synthesis.
```
  ○ ↘
  ○ → □
  ○ ↗
```

### Tree (Hierarchy)
Parent-child branching with connecting lines and free-floating text (no boxes needed). Use for: file systems, org charts, taxonomies.
```
  label
  ├── label
  │   ├── label
  │   └── label
  └── label
```
Use `line` elements for the trunk and branches, free-floating text for labels.

### Spiral/Cycle (Continuous Loop)
Elements in sequence with arrow returning to start. Use for: feedback loops, iterative processes, evolution.
```
  □ → □
  ↑     ↓
  □ ← □
```

### Cloud (Abstract State)
Overlapping ellipses with varied sizes. Use for: context, memory, conversations, mental states.

### Assembly Line (Transformation)
Input → Process Box → Output with clear before/after. Use for: transformations, processing, conversion.
```
  ○○○ → [PROCESS] → □□□
  chaos              order
```

### Side-by-Side (Comparison)
Two parallel structures with visual contrast. Use for: before/after, options, trade-offs.

### Gap/Break (Separation)
Visual whitespace or barrier between sections. Use for: phase changes, context resets, boundaries.

### Lines as Structure
Use lines (type: `line`, not arrows) as primary structural elements instead of boxes:
- **Timelines**: Vertical or horizontal line with small dots (10-20px ellipses) at intervals, free-floating labels beside each dot
- **Tree structures**: Vertical trunk line + horizontal branch lines, with free-floating text labels (no boxes needed)
- **Dividers**: Thin dashed lines to separate sections
- **Flow spines**: A central line that elements relate to, rather than connecting boxes

```
Timeline:           Tree:
  ●─── Label 1        │
  │                   ├── item
  ●─── Label 2        │   ├── sub
  │                   │   └── sub
  ●─── Label 3        └── item
```

Lines + free-floating text often creates a cleaner result than boxes + contained text.

---

## Shape Meaning

Choose shape based on what it represents, or use no shape at all:

| Concept Type | Shape | Why |
|--------------|-------|-----|
| Labels, descriptions, details | **none** (free-floating text) | Typography creates hierarchy |
| Section titles, annotations | **none** (free-floating text) | Font size/weight is enough |
| Markers on a timeline | small `ellipse` (10-20px) | Visual anchor, not container |
| Start, trigger, input | `ellipse` | Soft, origin-like |
| End, output, result | `ellipse` | Completion, destination |
| Decision, condition | `diamond` | Classic decision symbol |
| Process, action, step | `rectangle` | Contained action |
| Abstract state, context | overlapping `ellipse` | Fuzzy, cloud-like |
| Hierarchy node | lines + text (no boxes) | Structure through lines |

**Rule**: Default to no container. Add shapes only when they carry meaning. Aim for <30% of text elements to be inside containers.

---

## Color as Meaning

Colors encode information, not decoration. Every color choice should come from `references/color-palette.md`. The semantic shape colors, text hierarchy colors, and evidence artifact colors are all defined there.

**Key principles:**
- Each semantic purpose (start, end, decision, AI, error, etc.) has a specific fill/stroke pair
- Free-floating text uses color for hierarchy (titles, subtitles, details, each at a different level)
- Evidence artifacts (code snippets, JSON examples) use their own dark background + colored text scheme
- Always pair a darker stroke with a lighter fill for contrast

**Do not invent new colors.** If a concept doesn't fit an existing semantic category, use Primary/Neutral or Secondary.

---

## Modern Aesthetics

For clean, professional diagrams:

### Roughness
- `roughness: 0`: Clean, crisp edges. Use for modern/technical diagrams.
- `roughness: 1`: Hand-drawn, organic feel. Use for brainstorming/informal diagrams.

**Default to 0** for most professional use cases.

### Stroke Width
- `strokeWidth: 1`: Thin, elegant. Good for lines, dividers, subtle connections.
- `strokeWidth: 2`: Standard. Good for shapes and primary arrows.
- `strokeWidth: 3`: Bold. Use sparingly for emphasis (main flow line, key connections).

### Opacity
**Always use `opacity: 100` for all elements.** Use color, size, and stroke width to create hierarchy instead of transparency.

### Small Markers Instead of Shapes
Instead of full shapes, use small dots (10-20px ellipses) as:
- Timeline markers
- Bullet points
- Connection nodes
- Visual anchors for free-floating text

---

## Layout Principles

### Hierarchy Through Scale
- **Hero**: 300×150 - visual anchor, most important
- **Primary**: 180×90
- **Secondary**: 120×60
- **Small**: 60×40

### Whitespace = Importance
The most important element has the most empty space around it (200px+).

### Flow Direction
Guide the eye: typically left→right or top→bottom for sequences, radial for hub-and-spoke.

### Connections Required
Position alone doesn't show relationships. If A relates to B, there must be an arrow.

---

## Text Rules

**CRITICAL**: The JSON `text` property contains ONLY readable words.

```json
{
  "id": "myElement1",
  "text": "Start",
  "originalText": "Start"
}
```

Settings: `fontSize: 16`, `fontFamily: 3`, `textAlign: "center"`, `verticalAlign: "middle"`

---

## JSON Structure

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [...],
  "appState": {
    "viewBackgroundColor": "#ffffff",
    "gridSize": 20
  },
  "files": {}
}
```

## Element Templates

See `references/element-templates.md` for copy-paste JSON templates for each element type (text, line, dot, rectangle, arrow). Pull colors from `references/color-palette.md` based on each element's semantic purpose.

---

## Render & Validate (MANDATORY)

You cannot judge a diagram from JSON alone. After generating or editing the Excalidraw JSON, you MUST render it to PNG, view the image, and fix what you see (in a loop) until it's right. This is a core part of the workflow, not a final check.

### How to Render

```bash
cd <skill-directory>/references && uv run python render_excalidraw.py <path-to-file.excalidraw>
```

Replace `<skill-directory>` with the directory containing this loaded SKILL.md, as provided by Agent Farm.

This outputs a PNG next to the `.excalidraw` file. Then use the available image viewer on the PNG to actually inspect it, such as the Read tool, `view_image`, or a browser screenshot.

### The Loop

After generating the initial JSON, run this cycle:

**1. Render & View**: Run the render script, then Read the PNG.

**2. Audit against your original vision**: Before looking for bugs, compare the rendered result to what you designed in Steps 1-4. Ask:
- Does the visual structure match the conceptual structure you planned?
- Does each section use the pattern you intended (fan-out, convergence, timeline, etc.)?
- Does the eye flow through the diagram in the order you designed?
- Is the visual hierarchy correct (hero elements dominant, supporting elements smaller)?
- For technical diagrams: are the evidence artifacts (code snippets, data examples) readable and properly placed?
- For PR diagrams: does the rendered image tell a non-redundant before/after story through structure, not just labels?
- Would the image still communicate the main change if the prose paragraphs were removed?

**3. Check for visual defects:**
- Text clipped by or overflowing its container
- Text or shapes overlapping other elements
- Arrows crossing through elements instead of routing around them
- Arrows landing on the wrong element or pointing into empty space
- Arrowheads, dashed loops, or feedback paths visually sitting on top of boxes or labels
- Labels floating ambiguously (not clearly anchored to what they describe)
- Uneven spacing between elements that should be evenly spaced
- Sections with too much whitespace next to sections that are too cramped
- Text too small to read at the rendered size
- Overall composition feels lopsided or unbalanced
- Any part of the title, subtitle, truth statement, or major region clipped by the screenshot bounds
- A horizontally sprawling image whose important content is hard to scan in a GitHub PR
- PR-specific defects: the published image URL 404s, the PR body image does not render, or Markdown formatting collapses into a single paragraph.

**4. Fix**: Edit the JSON to address everything you found. Common fixes:
- Widen containers when text is clipped
- Adjust `x`/`y` coordinates to fix spacing and alignment
- Add intermediate waypoints to arrow `points` arrays to route around elements
- Reposition labels closer to the element they describe
- Resize elements to rebalance visual weight across sections
- Shrink titles and labels before enlarging the diagram further.
- Replace long labels with a diagrammatic construct: boundary, queue, gate, loop, timeline, or swimlane.

**5. Re-render & re-view**: Run the render script again and Read the new PNG.

**6. Repeat**: Keep cycling until the diagram passes both the vision check (Step 2) and the defect check (Step 3). Typically takes 2-4 iterations. Don't stop after one pass just because there are no critical bugs. If the composition could be better, improve it.

### When to Stop

The loop is done when:
- The rendered diagram matches the conceptual design from your planning steps
- No text is clipped, overlapping, or unreadable
- Arrows route cleanly and connect to the right elements
- Spacing is consistent and the composition is balanced
- You'd be comfortable showing it to someone without caveats
- For PR diagrams, the before and after are visually different in a way that reflects the actual code change.
- The diagram would not be equally useful as a plain bullet list.

### First-Time Setup
If the render script hasn't been set up yet:
```bash
cd <skill-directory>/references
uv sync
uv run playwright install chromium
```

Use the same loaded skill directory for both native harnesses.

---

## Quality Checklist

### Depth & Evidence (Check First for Technical Diagrams)
1. **Research done**: Did you look up actual specs, formats, event names?
2. **Evidence artifacts**: Are there code snippets, JSON examples, or real data?
3. **Multi-zoom**: Does it have summary flow + section boundaries + detail?
4. **Concrete over abstract**: Real content shown, not just labeled boxes?
5. **Educational value**: Could someone learn something concrete from this?

### Conceptual
6. **Isomorphism**: Does each visual structure mirror its concept's behavior?
7. **Argument**: Does the diagram SHOW something text alone couldn't?
8. **Variety**: Does each major concept use a different visual pattern?
9. **No uniform containers**: Avoided card grids and equal boxes?
10. **Non-redundant**: The image is not just the PR description repeated in boxes.
11. **Before/after story**: The old failure path and new success path are visibly different.
12. **Metaphor fit**: The chosen metaphor matches the change type (boundary, lifecycle, race, permission, ownership, etc.).

### Container Discipline
13. **Minimal containers**: Could any boxed element work as free-floating text instead?
14. **Lines as structure**: Are tree/timeline patterns using lines + text rather than boxes?
15. **Typography hierarchy**: Are font size and color creating visual hierarchy (reducing need for boxes)?

### Structural
16. **Connections**: Every relationship has an arrow or line
17. **Flow**: Clear visual path for the eye to follow
18. **Hierarchy**: Important elements are larger/more isolated

### Technical
19. **Text clean**: `text` contains only readable words
20. **Font**: `fontFamily: 3`
21. **Roughness**: `roughness: 0` for clean/modern (unless hand-drawn style requested)
22. **Opacity**: `opacity: 100` for all elements (no transparency)
23. **Container ratio**: <30% of text elements should be inside containers

### Visual Validation (Render Required)
24. **Rendered to PNG**: Diagram has been rendered and visually inspected
25. **No text overflow**: All text fits within its container
26. **No clipping**: Screenshot bounds include every title, label, arrow, and shape
27. **No overlapping elements**: Shapes and text don't overlap unintentionally
28. **Even spacing**: Similar elements have consistent spacing
29. **Arrows land correctly**: Arrows connect to intended elements without crossing others
30. **Readable at export size**: Text is legible in the rendered PNG
31. **Balanced composition**: No large empty voids or overcrowded regions
32. **GitHub readable**: The image is understandable when embedded in a PR without opening it full-size
