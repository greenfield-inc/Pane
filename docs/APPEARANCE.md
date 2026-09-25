# Appearance

Pane can follow the operating system or stay on a fixed palette. **System** remembers one light palette and one dark palette and selects between them as the OS appearance changes. **Fixed** uses a third, independent palette. Switching modes never replaces any remembered selection.

New installations default to System with Light (rounded) for the light slot and Dark (sharp) for the dark slot; the remembered Fixed palette is Light (rounded). Existing configurations that only contain `theme` migrate to Fixed so their current palette remains exact. The legacy palette also seeds the matching System slot, while the opposite slot keeps its default.

Palette slots are validated at load, renderer, IPC, and persistence boundaries. Only palettes whose canonical base class is `light` can occupy the light slot, and only palettes whose base is `dark` can occupy the dark slot. Invalid stored fields are repaired independently and reported by the main process.

## First paint

At startup the persisted config selects Electron's `nativeTheme` source. Main passes the four-field appearance snapshot through an argv argument and selects a cached, theme-specific BrowserWindow background colour. The preload decodes the snapshot synchronously; the HTML bootstrap resolves System against `prefers-color-scheme` and stamps the full class chain before React mounts. The provider then owns live OS updates, persistence, rollback, window controls, terminal, and editor updates. A versioned local cache and legacy `localStorage.theme` are fallback-only.

On Linux, System depends on the desktop environment and Chromium exposing `prefers-color-scheme`. Desktops that do not publish an appearance preference may remain on their reported default slot.

## App icon

`pnpm generate-icons` renders the general app assets from
`main/assets/icon-source.svg` and the macOS Dock assets from
`main/assets/icon-macos-source.svg`. The macOS Dock PNG and bundle ICNS use the
black-sky landscape artwork inside a transparent 1024px canvas so its visible size
matches neighboring Dock icons. The simpler PNG, ICO, and favicons continue to
serve Linux, Windows, and small web sizes. `pnpm dev` copies an updated Dock PNG
into the main-process build before launching Electron.
