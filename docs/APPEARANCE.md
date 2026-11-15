# Appearance

Pane can follow the operating system or stay on a fixed palette. **System** remembers one light palette and one dark palette and selects between them as the OS appearance changes. **Fixed** uses a third, independent palette. Switching modes never replaces any remembered selection.

New installations default to System with Folio for the light slot and Dusk (OLED) for the dark slot; the remembered Fixed palette is Folio. A saved appearance keeps whatever it holds, including the earlier defaults (Light (rounded) and Dark (sharp)); only missing or invalid fields take the new defaults. Existing configurations that only contain `theme` migrate to Fixed so their current palette remains exact. The legacy palette also seeds the matching System slot, while the opposite slot keeps its default.

Either System slot accepts any palette: each picker lists every theme, so a dark palette can follow a light OS and the reverse. Slots are named for the OS appearance they follow, not for the palette's own base. Palettes are validated at load, renderer, IPC, and persistence boundaries; invalid stored fields are repaired independently and reported by the main process.

## First paint

At startup the persisted config selects Electron's `nativeTheme` source. Main passes the four-field appearance snapshot through an argv argument and selects a cached, theme-specific BrowserWindow background colour. The preload decodes the snapshot synchronously; the HTML bootstrap resolves System against `prefers-color-scheme` and stamps the full class chain before React mounts. The provider then owns live OS updates, persistence, rollback, window controls, terminal, and editor updates. A versioned local cache and legacy `localStorage.theme` are fallback-only.

On Linux, System depends on the desktop environment and Chromium exposing `prefers-color-scheme`. Desktops that do not publish an appearance preference may remain on their reported default slot.

## Custom theme

An agent can restyle Pane when the person asks ("Tone down Pane's borders"). It writes one Custom theme, `custom-theme.json` in Pane's data folder beside `config.json`, through `runpane theme set` or the `theme_set` MCP tool. Pane restyles the main window and notify cards within a second, terminal colours included, with no restart.

```json
{
  "base": "dusk",
  "name": "Quiet Dusk",
  "colors": { "--color-border-primary": "#262b33" },
  "css": "[data-pane-part=\"tab\"] { border-radius: 8px !important; }"
}
```

- `base` is one of the 27 shipped themes. The Custom theme takes its light or dark family and fills every token it doesn't set.
- `colors` sets `--color-*` tokens to hex, `rgb()` or `rgba()` values. `runpane theme read` lists every token with its current value.
- `css` is up to 20,000 characters (the file up to 32 KB), applied after Pane's own styles.
- `name` is optional and shows in Settings.

`runpane theme set` merges colours into the current Custom theme (`null` removes one), replaces the CSS when `--css` is given, and selects Custom where the person sees it now: as the Fixed theme, or in the System slot of the base's family. `runpane theme set --theme <id>` switches to another theme and keeps the file. High contrast still wins over Custom colours for the tokens it sets.

**Stable selectors.** CSS should target only `[data-pane-part="<name>"]`: `app`, `sidebar`, `sidebar-pane`, `main`, `tab-bar`, `tab`, `panel`, `terminal`, `chat-message`, `chat-composer`, `button`, `input`, `dialog`, `settings`, `notify-card`. These stay across releases (a test keeps them). Tailwind classes, DOM shape and `data-testid` may change in any release. Terminal text is drawn on a canvas, so it takes colour tokens only.

**No remote files.** Pane refuses CSS with `@import`, `src()`, `image-set()` or a `url()` that isn't a `data:` or `#id` address, and writes nothing. The renderer filters the parsed rules again and drops any declaration that could still fetch, such as an escaped `url(`.

**Hand edits.** Pane reloads the file when it changes. An invalid file is ignored whole: Pane shows the base theme, and Settings > Appearance and `runpane theme read` give the reason.

**Reset.** Each of these deletes the Custom theme and returns to its base: Settings > Appearance > Custom theme > Reset, View > Reset Custom Theme (macOS), `runpane theme reset` from any shell, or deleting the file. There is no readability check, so use one of these when a theme makes Pane hard to read.

A setup export carries Custom as its base theme. Remote clients and the phone apps don't use the Custom theme.

## App icon

`pnpm generate-icons` renders the general app assets from
`main/assets/icon-source.svg` and the macOS Dock assets from
`main/assets/icon-macos-source.svg`. The macOS Dock PNG and bundle ICNS use the
black-sky landscape artwork inside a transparent 1024px canvas so its visible size
matches neighboring Dock icons. The simpler PNG, ICO, and favicons continue to
serve Linux, Windows, and small web sizes. `pnpm dev` copies an updated Dock PNG
into the main-process build before launching Electron.
