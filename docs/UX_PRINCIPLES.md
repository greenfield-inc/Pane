# UX principles: progressive disclosure

Guidelines for Pane's UI design, informed by Linear and Claude Code CLI patterns.

## Core Principles

### 1. Prompt-First, Options-Second

Every interaction should lead with the primary action. For session creation, that's the prompt. For settings, that's the most common toggle. Everything else is secondary and should be layered behind progressive disclosure.

**Do:** Auto-focus the primary input. Show one clear action.
**Don't:** Present a wall of fields, cards, and sliders on first load.

### 2. Opinionated Defaults Over Choice Overload

Provide one good default rather than forcing a choice. Users interpret defaults as expert recommendations (the "default effect"). When 80%+ of users will pick the same option, make it the default and let the rest override.

**Do:** Default to 1 session. Auto-generate names. Remember the last choice where a choice is needed.
**Don't:** Present every agent as an equal-weight card that must be picked every time.

### 3. The 80/20 Rule

Show the 20% of features that 80% of users need. Hide the rest behind expandable sections, overflow menus, or context menus. Every visible element competes for attention.

**Do:** Show prompt + create button. Put model selection, session count, branch config behind "Session options."
**Don't:** Show session count slider, tool cards, model dropdowns, and commit mode all at once.

### 4. Minimal Status Indicators

Match Claude Code CLI's simplicity. Status should be informative without being distracting. Simple text beats animated spinners. A color-coded dot beats a pulsing badge with rotating icons.

**Do:** Show `Thinking...` with subtle animated dots.
**Don't:** Show spinning rings, bouncing dots, rotating icons cycling through 8 images, and 41 wacky status messages.

### 5. Progressive, Not Hidden

Progressive disclosure is not about hiding features — it's about layering them. Users should always see a clear affordance that more options exist (chevron, "More options" link, overflow menu icon).

**Do:** Use `▸ Session options` with a chevron that expands to reveal fields.
**Don't:** Remove the session count slider entirely. Don't bury settings with no visual indicator.

## Patterns to Follow

### Linear's "One Good Way"

Linear deliberately constrains flexibility in favor of purpose-built workflows:
- Issue creation needs only a **title** — everything else is optional
- Smart pre-population (highlighted text auto-fills issue title)
- Opinionated at the atomic level (labels and due dates are issue properties, not configurable)
- Purpose-built over flexible

**Pane equivalent:** Creating a pane needs nothing typed: the name is auto-generated, and the agent and prompt are optional.

### Claude Code CLI's Minimalism

- Shows simple `thinking...` during processing — no visual noise
- Thinking content hidden by default, revealed via `Ctrl+O`
- Status line is optional and customizable
- Updates debounced at 300ms to prevent visual flicker

**Pane equivalent:** Keep status dots simple. No animations unless state actually changes.

### Collapsible Section Pattern

Use for grouping secondary options:
- Clear heading that describes what's inside
- Chevron indicator (▸ collapsed, ▾ expanded)
- Remember expansion state in user preferences
- Keep disclosure levels below 3 (avoid nesting collapsibles inside collapsibles)

### Overflow Menu Pattern

Use when 3+ utility actions compete for toolbar space:
- Keep the most-used action visible (with keyboard shortcut)
- Group remaining actions behind `⋯` (MoreHorizontal) icon
- Menu items should have icons + labels
- Include state indicators where relevant (e.g., "Sort: Newest first")

## When NOT to Simplify

Progressive disclosure fails when critical information is hidden:
- Never hide destructive actions behind progressive disclosure without confirmation
- Don't hide information users need to make decisions (e.g., hiding that a session will use Codex instead of Claude)
- Don't over-simplify settings that have security implications (API keys, permission modes)
- If sales/engagement drops after hiding something, bring it back — trust trumps minimalism

## Visual Design Principles

### Reduce Visual Noise
- Fewer colors, fewer animations, fewer competing elements
- Use whitespace to create hierarchy
- Sequential content flow (top-to-bottom)
- One primary action per view

### Animations
- Only animate to communicate state changes (not for decoration)
- Respect `prefers-reduced-motion` OS setting
- Debounce status updates (300ms minimum)
- Subtle > flashy. Text > spinners. Dots > bouncing balls.

### Color
- Use color sparingly and consistently for status:
  - Green: running/success
  - Yellow: waiting/attention needed
  - Red: error
  - Blue: new/unviewed activity
  - Gray: completed/inactive

## References

- [The Linear Method: Opinionated Software](https://www.figma.com/blog/the-linear-method-opinionated-software/)
- [How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [Progressive disclosure in UX: Types and use cases (LogRocket)](https://blog.logrocket.com/ux-design/progressive-disclosure-ux-types-use-cases/)
- [Designing for Progressive Disclosure (UXmatters)](https://www.uxmatters.com/mt/archives/2020/05/designing-for-progressive-disclosure.php)
- [The Default Effect in UX](https://www.ux-bulletin.com/default-effect-in-ux/)
- [Claude Code CLI Status Line Docs](https://code.claude.com/docs/en/statusline)
