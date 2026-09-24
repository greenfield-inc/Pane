# Excalidraw Diagram Skill

A coding agent skill that generates beautiful and practical Excalidraw diagrams from natural language descriptions. Not just boxes-and-arrows - diagrams that **argue visually**. It also supports PR visual overviews that teach before/after changes to reviewers.

Run this skill through Agent Farm with a profile that selects `excalidraw-pr-diagrams`.

## What Makes This Different

- **Diagrams that argue, not display.** Every shape/group of shapes mirrors the concept it represents: fan-outs for one-to-many, timelines for sequences, convergence for aggregation. No uniform card grids.
- **Evidence artifacts.** As an example, technical diagrams include real code snippets and actual JSON payloads.
- **Built-in visual validation.** A Playwright-based render pipeline lets the agent see its own output, catch layout issues (overlapping text, misaligned arrows, unbalanced spacing), and fix them in a loop before delivering.
- **PR-ready handoff.** The skill covers shareable reviewer explainers, durable repository-owned release assets, inline GitHub images, and PR body preview checks.
- **Brand-customizable.** All colors and brand styles live in a single file (`references/color-palette.md`). Swap it out and every diagram follows your palette.

## Installation

The implementer profile includes this skill:

```sh
agent-farm run implementer --directory /path/to/project
```

Agent Farm packages the skill and its supporting files for the selected harness.
For local development, use `--config-root /path/to/skills-repository`.

## Setup

The skill includes a render pipeline that lets the agent visually validate its diagrams. There are two ways to set it up:

**Option A: Ask your coding agent (easiest)**

Just tell your agent: *"Set up the Excalidraw diagram skill renderer by following the instructions in SKILL.md."* It will run the commands for you.

**Option B: Manual**

```bash
cd <skill-directory>/references
uv sync
uv run playwright install chromium
```

Replace `<skill-directory>` with the loaded skill directory reported by Agent Farm.

## Usage

Ask your coding agent to create a diagram:

> "Create an Excalidraw diagram showing how the AG-UI protocol streams events from an AI agent to a frontend UI"

Or ask for a PR visual overview:

> "Create a shareable PR diagram that explains the before and after behavior, publish the PNG on the repo's long-lived pr-assets release, and update the PR body."

The skill handles the rest: concept mapping, layout, JSON generation, rendering, and visual validation.

## Customize Colors

Edit `references/color-palette.md` to match your brand. Everything else in the skill is universal design methodology.

## File Structure

```
excalidraw-pr-diagrams/
  SKILL.md                          # Design methodology + workflow
  references/
    color-palette.md                # Brand colors (edit this to customize)
    element-templates.md            # JSON templates for each element type
    json-schema.md                  # Excalidraw JSON format reference
    render_excalidraw.py            # Render .excalidraw to PNG
    render_template.html            # Browser template for rendering
    pyproject.toml                  # Python dependencies (playwright)
```
