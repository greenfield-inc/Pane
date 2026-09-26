---
name: html-explainer
description: The house standard for any skill that renders an HTML page for a person to read, covering design tokens, typography, components, diagrams, and quality gates so every generated page shares one calm, graphic-first look. Use when a skill's instructions say to render its output per the html-explainer standards, or when the user asks for an HTML explainer of anything and no more specific skill applies.
argument-hint: "[what to explain, when invoked directly]"
allowed-tools: Read, Grep, Glob, Bash, Write
---

# HTML Explainer

## Task: $ARGUMENTS

A page for a person is pictures interrupted by words. The diagram
carries the argument and the prose annotates it, the way a whiteboard
sketch carries a design review; a section that has no visual either
earns its place in prose or belongs folded into depth. Without one
standard, every generated page invents its own fonts, colors, and
structure, and the reader pays for the drift. This skill is where the
look and the bar live. `eli5` renders with it (other pages follow
`page`); invoked
directly, it renders a one-off explainer of whatever the argument
names.

## The file

One self-contained `.html` file, tuned entirely for reading: there is
no hosting, no publish step, no capability layer to design for. Inline
CSS in a single `<style>` block, inline SVG for every drawing, no
external requests of any kind: no CDN, no web fonts, no remote images,
no scripts unless the page genuinely needs interaction, and then only
vanilla inline JS. System font stacks only. Target well under 200KB.
Write it to `./tmp/` (or the caller's stated destination), then open it
unless the caller says not to. Inside Pane (`PANE_SESSION_ID` is set), run
`runpane panels open --file <path> --source agent --yes --json`; it opens a
browser tab in split view beside the conversation. Elsewhere use the system
browser (`open` on macOS, `xdg-open` on Linux).

## Tokens

Copy this block verbatim as the start of the style sheet. Extend it
only by adding tokens, never by restyling these.

```css
:root {
  --paper: #FAF8F5; --ink: #1F2328; --ink-soft: #5A5F66;
  --line: #E4DFD7; --panel: #FFFFFF;
  --accent: #0E7569; --accent-soft: #E3F0EE;
  --warn: #B45309; --warn-soft: #F7EBDD;
  --bad: #9F3A38; --bad-soft: #F6E8E7;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --serif: Georgia, "Iowan Old Style", "Times New Roman", serif;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #15191D; --ink: #E8E6E1; --ink-soft: #9BA1A8;
    --line: #2C3237; --panel: #1C2126;
    --accent: #2FA79A; --accent-soft: #16302D;
    --warn: #D98E3D; --warn-soft: #32271A;
    --bad: #CF6F6C; --bad-soft: #33211F;
  }
}
```

## Drawings

Every page opens with one drawing directly after the masthead: the
whiteboard sketch the rest of the page elaborates. More follow wherever
a relationship, a flow, or a comparison is the point; drawing first and
writing around the drawing is the intended order of work.

- Inline SVG on the tokens: `--panel` fills, `--line` strokes,
  `--accent` for the path that matters, `--warn` and `--bad` where
  verdicts are part of the picture, `--sans` labels at 12 to 14px.
- Sketch energy over precision: slightly rounded corners, imperfect
  widths, dashed strokes for the tentative and solid for the certain,
  arrows with real heads. Boxes and arrows over art; three boxes and an
  arrow beats a mural.
- Warmth comes from the drawing, never from decoration: no gradients,
  no shadows, no icon fonts, no clip art.
- Legible at page width, `viewBox` set, no fixed pixel widths. A simple
  subject gets a simple drawing, never a skipped one.
- When the user wants a diagram they can edit themselves, that is the
  excalidraw-pr-diagrams skill's job, not an inline SVG.

## Type and layout

- Body: `--sans`, 16px, line-height 1.6, `--ink` on `--paper`, one
  centered column, `max-width: 72ch`, generous vertical rhythm.
- `h1`: `--serif`, weight 500, ~2.1rem, `text-wrap: balance`. One per
  page. Directly under it, a one-sentence standfirst in `--ink-soft`.
- Section headers: a mono uppercase eyebrow (`.72rem`, letter-spacing
  `.1em`, `--accent`) above an `h2` (~1.25rem). Sections are numbered
  when order matters and unnumbered when it does not.
- Code: `--mono` on `--panel` with a `--line` border. Prose lines stay
  under 90 characters; nothing scrolls horizontally except inside a
  `pre` with its own overflow.

## Components

The whole vocabulary. A page uses what it needs and invents nothing:

- `.badge`: mono, uppercase, `.72rem`, soft background. Accent for
  identity and success, warn for caution, bad for failure. Badges carry
  verdicts; prose carries reasons.
- `.panel`: `--panel` background, `--line` border, 6px radius, padded.
  The unit of grouped content; grids of panels for comparisons
  (before/after, expected/actual).
- `.callout`: a panel with a 3px left border in accent, warn, or bad.
  One-paragraph emphasis, used sparingly.
- `.card`: a panel with a mono eyebrow title, for repeating items
  (a lesson, a promise, a dependency).
- `details > summary`: for depth the reader opts into. The page must
  read complete with every `details` closed.

## The bar

Before opening the page, verify all of these; fix rather than ship:

1. The drawings could carry the page alone: a reader who skims only
   them and the headers leaves oriented.
2. Renders complete with JavaScript disabled and every `details`
   closed.
3. Nothing is fetched: no `src`, `href`, or `url()` that loads an
   external resource (stylesheet, script, font, image). URLs quoted as
   text or code content are fine; a page about an endpoint must be able
   to print it.
4. Both color schemes hold: readable in light and dark.
5. Every fact on the page came from the caller's material; the page
   adds structure and pictures, never claims.
6. One `h1`, sections in reading order, nothing beyond the component
   vocabulary above.

## Boundaries

- This skill owns form. The invoking skill owns content, truth, where
  the file lives, and what the chat reply says; its reply and
  open-in-browser rules override the defaults here.
- When a caller's needs exceed the vocabulary, extend the vocabulary
  here in a PR, do not fork the style inline.
- No em dashes, on the page and in this file.
