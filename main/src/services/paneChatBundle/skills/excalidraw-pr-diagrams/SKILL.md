---
name: excalidraw-pr-diagrams
description: Draw Excalidraw diagrams that make a visual argument, such as a pull request's before/after visual overview, an architecture, a workflow or a shareable explainer, then render them to PNG and check them by eye.
---

# Excalidraw PR diagrams

A diagram argues; it doesn't display. Its shape should carry the meaning, so a reader can explain the change by pointing at it.

## Workflow

1. **Find the visual truth.** Before drawing, name what the change does, and pick the structure that shows it:

   | The change... | Draw |
   |---|---|
   | moves a boundary | walls, trust zones, process or origin boundaries |
   | changes a lifecycle | a state machine, gate sequence or retry loop |
   | moves responsibility | before/after ownership regions, with the action crossing them |
   | removes a failure mode | the old path dead-ending, the new path avoiding it |
   | fixes a race | timelines, clocks or joins |
   | changes validation or permissions | a decision path with the gate and what passes |
   | fans out, converges, or transforms | radial arrows, a funnel, or input → process → output |

   Give each major concept its own pattern. Two PRs that fix different kinds of problems get different layouts.
2. **Gather the real details.** Use the actual endpoint paths, event names, fields and example payloads from the code or spec. Concrete artifacts teach: a dark code box with the real query or command, a mock of the real menu or dialog built from nested rectangles, or bars on a time axis for states over time. Tag the pieces the PR adds or changes with small `NEW`, `CHANGED` or `REUSED` badges.
3. **Write the file** in a working folder outside the repository's tracked files: `$PANE_SCRATCH_DIR/pr-diagrams/<repo>-<pr>/overview.excalidraw` in Pane, else `/tmp/pr-diagrams/...`, using the format below. Build a large diagram one region per edit, or generate repeated pieces (timeline rows, badges) with a short script. For a PR whose diff is mostly generated files, list it with `gh pr diff --name-only` and read only the files that matter.
4. **Render and look** (below), fix what you see, and repeat until the checks at the end pass, usually 2–4 rounds.

A PR visual overview always has:
- a **Before** path, where the old system failed or was fragile;
- an **After** path, through the new route or control point;
- at least one structure (boundary, timeline, loop, funnel, state machine, swimlane, queue, fan-out or layers);
- one short **truth statement** in plain language;
- a small **term explainer** for any protocol word a reviewer may not know (header, preflight, origin, token, cookie, cache key…): define it in a few plain words, then keep the official term in parentheses, for example `permission check (CORS preflight)`. Show who acts: `Browser asks`, `API answers`.

For a shareable explainer, title it with the outcome rather than the implementation, put the old blind spot on the left and the new loop or control point on the right, and include one real input and one real output.

## File format

Write short element skeletons. The renderer fills in ids, seeds, bindings and text sizes, and writes the expanded file to `<name>.full.excalidraw`, which opens in excalidraw.com for editing.

```json
{"type": "excalidraw", "version": 2, "elements": [
  {"type": "text", "x": 0, "y": 0, "text": "After: the token is checked before the write", "fontSize": 26, "strokeColor": "#1e40af"},
  {"type": "rectangle", "id": "client", "x": 0, "y": 80, "width": 200, "height": 80,
   "backgroundColor": "#fed7aa", "strokeColor": "#c2410c", "label": {"text": "Browser sends\nPOST /orders"}},
  {"type": "diamond", "id": "gate", "x": 320, "y": 70, "width": 180, "height": 100,
   "backgroundColor": "#fef3c7", "strokeColor": "#b45309", "label": {"text": "token valid?"}},
  {"type": "arrow", "x": 200, "y": 120, "width": 120, "height": 0, "start": {"id": "client"}, "end": {"id": "gate"}, "label": {"text": "1"}},
  {"type": "line", "x": 0, "y": 200, "points": [[0, 0], [820, 0]], "strokeStyle": "dashed", "strokeColor": "#64748b"},
  {"type": "ellipse", "x": 0, "y": 230, "width": 14, "height": 14, "backgroundColor": "#3b82f6", "strokeColor": "#3b82f6"}
]}
```

- Types: `rectangle` (an action or component), `ellipse` (a start, an end, or a 10–20 px timeline dot), `diamond` (a decision), `arrow` (a relationship), `line` (timelines, trees, dividers), `text`.
- Bind an arrow to rectangles and ellipses with `start`/`end` ids. For a diamond, leave the arrow unbound and give its `points`, so it leaves from the edge you choose.
- With `start`/`end` set, the arrow's ends snap to the shapes; still give `x`, `y` and `points` as a starting route.
- Size text with monospace at about 0.6 × font size per character, plus 24 px of padding inside a box. A badge is a small rectangle with a 12 px label, for example `NEW` at 56 × 24.
- A label inside a shape takes the shape's stroke colour; set `label.strokeColor` to change it. Where an arrow label would cross another line, use free-floating text beside the arrow instead.
- The defaults are clean edges (`roughness: 0`), rounded rectangles, a monospace font (`fontFamily: 3`) and `strokeWidth: 2`. Set `roughness: 1` only for a sketchy look.
- Add `"strokeStyle": "dashed"` for an inactive or removed path, and `"roundness": null` for square corners.

**Colours** (fill / stroke; keep a darker stroke on a lighter fill):

| Meaning | Fill | Stroke |
|---|---|---|
| Neutral, primary | `#dbeafe` | `#1e3a5f` |
| Start, trigger | `#fed7aa` | `#c2410c` |
| Success, end | `#a7f3d0` | `#047857` |
| Decision | `#fef3c7` | `#b45309` |
| Error, failure | `#fecaca` | `#b91c1c` |
| AI, model | `#ddd6fe` | `#6d28d9` |
| Code or data box | `#1e293b` | `#1e293b`, with text in `#22c55e` or `#e2e8f0` |

Text colours: title `#1e40af`, subtitle `#3b82f6`, detail `#64748b`. Colour supports the meaning but never carries it alone.

## Layout and text

- Plan for about 1600–2200 px wide and 900–1400 px tall, with two or three clear regions, 80 px outer margin and 50 px between regions.
- Titles 24–30 px and under about 55 characters; labels 14–18 px; at most four short lines per shape, with line breaks written in.
- Leave most text free-floating, with font size and colour as hierarchy; box something only when it's a focal point, a "thing" in the system, or an arrow end.
- Give the most important element the most space. Every relationship gets an arrow; route loops around the outside of boxes.

## Render and check

Render from your working folder:

```bash
node <skill-directory>/references/render.mjs "$PANE_SCRATCH_DIR/pr-diagrams/<repo>-<pr>/overview.excalidraw"
```

`<skill-directory>` is this skill's folder. The PNG lands next to the file, sized to the diagram. The renderer installs nothing. It needs Node 22 or newer, a browser already on the machine (Chrome, Edge or Chromium; set `BROWSER_PATH` for another location), and network access, because it loads Excalidraw from esm.sh. If it can't run, put a Mermaid flowchart with the same before and after paths in the Visual Overview, and say the image wasn't rendered.

Look at the PNG with your image-reading tool (for example the Read tool), then check:
- **The argument:** without the prose, the image still shows the before/after difference through structure, and isn't just the PR text in red and green boxes.
- **The fit:** no text is clipped or overlapping, arrows land on the right element without crossing others, spacing is even, and the title doesn't dominate.
- **The size:** it reads at the width GitHub shows in a PR. If it's too wide or wordy, stack regions vertically and cut prose.

## Publishing on a PR

PR images are hosted, not committed.
1. **Reuse the repository's long-lived asset release** (for example `pr-assets`; check with `gh release view pr-assets`). Creating that release needs the person's explicit go-ahead, once per repository. Without it, keep the PNG local and report publishing as blocked, with the exact `gh release create` and `upload` commands.
2. **Name the file by content:** `pr-<number>-<head-short-sha>-<sha256-first-12>-visual-overview.png`. Reuse an existing asset only when its digest matches. For different content, upload under a new name, so images in older PRs never change.
3. **Verify the upload:** download the asset URL and compare its SHA-256 and size with the local file.
4. **Embed it** right under the PR's summary, in a `## Visual Overview` section between `<!-- pr-visual-overview:start -->` and `<!-- pr-visual-overview:end -->`, followed by the link to the PR's own artifact (`prepare-pr`'s companion page). In a private repository, add a line under the image: "The image may not show for everyone; it and the rest of this PR's material are in <the PR's artifact>." Replace only that section on reruns.
5. **Read the PR body back** and confirm the image loads and the Markdown renders as separate sections.

Commit an image only when tracked docs need it, under `docs/` or `.github/pr-assets/`. Keep `.excalidraw` sources outside the repository unless the person asks to track them.
