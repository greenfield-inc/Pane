/**
 * The stable selectors custom CSS may target: `[data-pane-part="<name>"]`.
 * Each is kept across releases; paneParts.test.ts fails, naming the part, when
 * one disappears from the frontend source. Every other selector (Tailwind
 * classes, DOM shape, data-testid) may change in any release.
 */
export const PANE_PARTS = [
  'app',
  'sidebar',
  'sidebar-pane',
  'main',
  'tab-bar',
  'tab',
  'panel',
  'terminal',
  'chat-message',
  'chat-composer',
  'button',
  'input',
  'dialog',
  'settings',
  'notify-card',
] as const;

export type PanePart = typeof PANE_PARTS[number];

/** What `runpane theme read` tells an agent before it restyles Pane. */
export const THEME_GUIDE = [
  'Restyle Pane itself only when the person asks to change how Pane looks. A request about their project\'s own styles is not about Pane.',
  'Prefer colour tokens (`--colors`) to CSS: they reach the terminal, notify cards and the window background. Values are hex, rgb() or rgba().',
  `In CSS, target only the stable selectors: ${PANE_PARTS.map((part) => `[data-pane-part="${part}"]`).join(', ')}. Every other class, id or structure may change in any release.`,
  'Custom CSS loads after Pane\'s own styles. When a rule has no effect, add !important.',
  'CSS cannot load files: no @import, src(), image-set() or remote url(). Use url("data:...") for images. Terminal text takes colour tokens only.',
  'You cannot see the result. Make small changes, then ask the person how it looks.',
  'Each set merges colours into the Custom theme (null removes one) and replaces its CSS when --css is given. To switch away: `runpane theme set --theme <id>`. The person can reset with Settings > Appearance > Reset, View > Reset Custom Theme on macOS, `runpane theme reset`, or by deleting the file.',
].join('\n');
