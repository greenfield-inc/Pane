---
name: page
description: House standard for any HTML page written for a person. Use when another skill says to render a page.
---

# Page

This skill owns form. The skill that asked for the page owns the content, the facts, and where it is saved.

## The file

One self-contained `.html` file. Inline CSS in one `<style>` block, inline SVG for drawings, system fonts, no external requests of any kind, and no script unless the page needs interaction. Keep it well under 200KB.

Every page belongs to a bundle, and a bundle has a destination. Read [references/bundle.md](references/bundle.md) before saving the first page for a piece of work: it sets the folder, the file names, how pages link to each other, and how to publish somewhere other than the local default. Open the page for the person, or give them its link.

## Colours

Start the style sheet with this block. Add tokens if you need them, and keep these values as they are. Give `body` an explicit background and text colour.

```css
:root {
  --bg: #fbfaf6; --panel: #ffffff; --ink: #1d2420; --muted: #5d6861; --line: #dcdfd6;
  --accent: #2f7d4f; --accent-soft: #e4f1e7;
  --warn: #9a5b00; --warn-soft: #fbefd9;
  --bad: #a23a2f; --bad-soft: #f9e4e1;
  --code: #f0f1eb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141815; --panel: #1b211d; --ink: #e7ebe6; --muted: #9aa69e; --line: #2e3731;
    --accent: #6fc38d; --accent-soft: #1e3327;
    --warn: #e5b566; --warn-soft: #352a15;
    --bad: #ef9388; --bad-soft: #3a1f1c;
    --code: #232a25;
  }
}
```

## Draw first

Open with one drawing right after the title: the whiteboard sketch the rest of the page explains. Add more wherever a flow, a relationship, or a comparison is the point. Boxes and arrows in inline SVG, using the tokens, with a `viewBox` and no fixed pixel widths. Use `--accent` for the path that matters, and dashed strokes for anything tentative. No gradients, shadows, icon fonts, or clip art. A simple subject gets a simple drawing, never none.

## Layout

- One centred column, about 72 characters wide, 16px text, line height 1.6, 16px side gutters on a phone, and no horizontal scrolling outside a `pre`.
- One `h1`, with a one-sentence summary under it. A status chip beside it when the document has a status.
- Put what the person must decide or act on first, before background.
- Tables for comparisons. Side-by-side panels for before and after, or today and wanted.

## Components

Use what the page needs and invent nothing else: a status chip, a panel, a call-out with a coloured left border (accent, warn, bad), a card for repeated items, and `details` for depth the reader opts into. The page must read complete with every `details` closed.

## Before you share it

1. Someone who reads only the drawings and headings leaves oriented.
2. It renders complete with JavaScript disabled.
3. Nothing is fetched from anywhere.
4. It is readable in both light and dark.
5. Every fact came from the material you were given. The page adds structure and pictures, never claims.
