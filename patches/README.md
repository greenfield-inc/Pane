# Dependency patches

pnpm applies these through `pnpm.patchedDependencies` in the root `package.json`.

## @xterm/addon-webgl

Output that keeps changing 24-bit colors, such as Claude Code's animated
shimmer, adds a new glyph to the texture atlas for every color. Atlas pages
merge and double up to the GPU's `MAX_TEXTURE_SIZE` (16384 px on most desktop
GPUs, 1 GiB per page), and merged or evicted page canvases free their memory
only when garbage collected. The patch, in both `lib/` bundles:

1. Caps `TextureAtlas.maxTextureSize` and `_deviceMaxTextureSize` at 4096 px,
   the addon's intended `FORCED_MAX_TEXTURE_SIZE`.
2. Sets merged-away and evicted page canvases to 0x0 so their memory frees
   right away.

4096 px is the largest cap that keeps the GPU process near 2 GB under a
never-repeating truecolor shimmer: 8192 px peaks near 7 GB and 16384 px near
17 GB, with longer merge stalls. At 4096 px the atlas resets a few times a
minute under that worst case, with no visible glyph flashes in canvas
recordings, and never resets under normal agent output.

Measure with `scripts/benchmark-webgl-atlas.js`. After bumping the addon,
check whether upstream now clamps the texture size (search the bundle for
`Math.min(4096`); if not, regenerate with `pnpm patch @xterm/addon-webgl@<version>`,
reapply the two edits above, and `pnpm patch-commit <dir>`.
