# Keyboard Shortcut Profiles (Superset default for new users)

## Intent

Pane gains named keyboard-shortcut **profiles**: complete default keymaps a user
picks between, layered under their per-command overrides. Two profiles ship:

- **`pane`** — today's catalog defaults, unchanged.
- **`superset`** — Pane's commands mapped onto the default keymap of
  [superset-sh/superset](https://github.com/superset-sh/superset)
  (`apps/desktop/src/renderer/hotkeys/registry.ts`), so users coming from
  Superset keep their muscle memory.

**New users (fresh installs, no existing config file) default to `superset`.**
Every existing config — with or without overrides — stays on `pane`; nothing
changes for them on update and no migration prompt is shown.

## Resolution model

Effective chord for a command becomes a four-level fallthrough:

```
user override  →  unassigned (null)  →  profile chord  →  catalog default
```

- A profile is a sparse `id → chord | null | { darwin, other }` map over the
  shared catalog. Missing id ⇒ catalog default. `null` ⇒ unassigned in that
  profile. The `{ darwin, other }` form exists because Superset's own
  Windows/Linux convention is `Ctrl+Shift+…` (plain `Ctrl` belongs to the
  shell), which is *not* a mechanical `⌘ → Ctrl` translation of its macOS
  chords. `other` covers every non-darwin host.
- Overrides are stored **per profile** so switching back and forth loses
  nothing: the `pane` profile keeps using the existing
  `keyboardShortcutOverrides` config key; non-pane profiles store theirs under
  `keyboardShortcutProfileOverrides[profileId]`. Both keys round-trip verbatim
  (unknown ids / malformed values preserved on disk), like #554 established.
- `keyboardShortcutProfile` holds the active profile id; absent or unknown
  values resolve to `pane` at runtime and are preserved on disk.
- Conflict validation stays global (no platform gate for catalog `platforms`
  filtering), but profile chord variants resolve against the **host** platform
  — a separate input from the availability-filter platform.

## The Superset profile mapping

Constraints that shaped it:

- Pane's chord grammar collapses Ctrl/Meta into one `mod` token, so Superset's
  macOS `⌃`-literal bindings (`⌃1–9` scripts, `⌃Tab`/`⌃⇧Tab` tab cycling)
  cannot be expressed distinctly from `⌘` chords on macOS.
- Pane is one-chord-per-command, so Superset's duplicate bindings
  (`PREV_TAB` + `PREV_TAB_ALT`) collapse to one.
- Terminal-reserved chords (`mod+F/V/Q/P/K/C`) can't be assigned; Superset's
  `⌘F` (find) and `⌘K` (clear) are already Pane's native terminal behavior,
  and `⌘P` (Quick Open) has no Pane command.
- One chord per (profile, platform) — the profile must be conflict-free under
  Pane's global validator on both darwin and non-darwin; a unit test enforces
  this.

Assignments (darwin / other; single value = both):

| Pane command | Superset source | Chord |
|---|---|---|
| `open-command-palette` | Command Palette | `mod+shift+k` |
| `toggle-sidebar` | Toggle Sidebar (`⌘L`) | `mod+l` / `mod+shift+l` |
| `toggle-detail-panel` | Toggle Workspaces Sidebar (`⌘B`) | `mod+b` / default |
| `split-right` | Split Right (`⌘D`) | `mod+d` / `mod+shift+d` |
| `split-down` | Split Down (`⌘⇧D`) | `mod+shift+d` / `mod+alt+shift+d` |
| `close-active-tab` | Close Pane (`⌘W`) | default / `mod+shift+w` |
| `archive-active-session` | Close Workspace | `mod+shift+Backspace` |
| `new-session` | New Workspace (`⌘N`) | default / `mod+shift+n` |
| `new-project` | Open Project (`⌘⇧O`) | `mod+shift+o` / `mod+alt+shift+o` |
| `switch-session-1..9` | Jump to Workspace N | default (`mod+N`) / `mod+shift+N` |
| `panel-tab-1..9` | Jump to Tab N (`⌘⌥N`) | `mod+alt+N` / `mod+alt+shift+N` |
| `cycle-tab-next-d` / `prev-a` | Next/Prev Tab (`⌃Tab`) | `mod+Tab` / `mod+shift+Tab` |
| `cycle-session-next-0` / `prev-0` | Next/Prev Workspace (`⌘⌥↓/↑`) | `mod+alt+ArrowDown/Up` / `mod+alt+shift+ArrowDown/Up` |
| `add-tool-terminal` | New Terminal (`⌘T`) | `mod+t` / `mod+shift+t` |
| `open-add-tool` | — (relocated off `⌘T`) | `mod+shift+t` / `mod+alt+shift+t` |
| `run-dev-server` | Run Workspace Command (`⌘G`) | `mod+g` / `mod+shift+g` |
| `open-shortcut-settings` | Show Keyboard Shortcuts | `mod+shift+/` |
| `add-tool-explorer` | — (relocated) | `mod+alt+o` |
| `add-tool-terminal-claude` | — (relocated) | `mod+alt+c` |
| `add-tool-terminal-codex` | — (relocated) | `mod+alt+x` |
| `add-tool-terminal-cursor` | — (relocated) | `mod+alt+u` |
| `add-tool-custom-0..3` | — | unassigned |
| `git-commit` | — (displaced by `mod+shift+k`) | `mod+alt+k` |
| `git-pull` | — (displaced by `mod+shift+l` on other) | `mod+alt+l` |
| `usage-download` | — (displaced by split chords) | `mod+alt+i` |
| `focus-group-up` / `focus-group-down` | Superset ships pane-focus unbound | unassigned |

Deliberate deviations, documented here rather than silently: `focus-group-left`
/`-right` keep `mod+alt+←/→` (Superset uses those for another tab-cycle
duplicate; keeping split navigation is worth more), `cycle-sidebar-session-*`
keep `mod+↑/↓` (Superset has no second workspace-cycle pair), and Superset
commands with no Pane counterpart (Quick Open, split-auto/browser/desktop,
equalize, zoom, open-in-app, copy-path, rich input, reopen tab, chat
focus/attach, check resources, back/forward) map to nothing. Relocation chords avoid the default terminal snippets, which occupy `mod+alt+E/R/D/S`.

## Surfaces

- **Settings → Shortcuts** gains a "Keymap profile" selector above the
  key-binding map (options: Superset, Pane Classic). Switching the selector
  swaps the map's Default column, row states, and the overrides draft to the
  selected profile's stored overrides; Apply persists profile + that profile's
  override map together and is blocked by conflicts exactly as before. The
  recorder's own-default grandfathering follows the profile default.
- **Help** renders the active profile. Add Tool menu hints, launch presets, TUI
  release + webview forwarding all follow automatically via the shared
  resolvers.
- Main-process conflict logging validates each stored profile map against its
  own profile's defaults.

## Acceptance criteria

1. Fresh install (no config file) seeds `keyboardShortcutProfile: 'superset'`;
   an existing config file without the key behaves as `pane` and is not
   rewritten.
2. Under the Superset profile the mapping table above is the effective keymap
   (spot-checked by tests: `mod+shift+k` palette, `mod+t` new terminal,
   `mod+alt+c` Claude, `mod+alt+N` tab jumps; `mod+alt+3` no longer launches
   Claude).
3. The Superset profile is conflict-free under `findChordConflicts` on darwin
   and non-darwin (unit-enforced), every profile chord parses, every id exists
   in the catalog, and no profile chord is terminal-reserved-shaped unless it
   is that row's effective default (recorder grandfathering).
4. Overrides are per-profile: customizing a chord under one profile, switching
   profiles, and switching back restores the customization; Reset all only
   clears the active profile's map.
5. Unknown/malformed profile ids and override maps round-trip on disk
   untouched and fall back to `pane` at runtime.
6. `pnpm typecheck && pnpm lint` clean; existing unit + Playwright suites stay
   green with the `pane` profile as the implicit default in tests.
