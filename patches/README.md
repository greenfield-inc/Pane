# Dependency patches

pnpm applies these through `patchedDependencies` in `pnpm-workspace.yaml`.

## @xterm/addon-search

Find in a terminal searches a soft-wrapped line (a long log line, minified
JSON) as one string. Unpatched, every wrapped row of that line walked back to
its first row, recursively, and re-read every earlier row's cells to place the
search start. A 500,000-character line (2,500 rows) took about 625 million
cell reads per keystroke for a query with no match, seconds of frozen UI, and
overflowed the stack. The patch, in both `lib/` bundles:

1. Skips soft-wrapped continuation rows in the forward search loops (`find`
   and `findNextWithSelection`), because the search from the line's first row
   already covered them. Whole-word search keeps the old path, since it stops
   at the first non-whole-word hit in a line.
2. Takes a wrapped row's string offset from the line cache's row offsets
   instead of re-walking the cells of every earlier row.
3. Walks back to a wrapped line's first row in a loop instead of one
   recursive call per row.
4. Lower-cases a line once per search instead of once per match: highlighting
   calls `find` for each of up to 1,000 matches, and each call lower-cased the
   whole joined line (about 100 ms per keystroke on that 500,000-character
   line).

`frontend/src/components/terminal/searchAddonWrappedLines.test.ts` runs the
patched addon over such a line. When bumping the addon, run that test against
the new version unpatched first; if it passes, drop the patch. Otherwise
regenerate it with `pnpm patch @xterm/addon-search@<version>` and reapply the
four edits.

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

## @xterm/xterm

Find in a terminal (`@xterm/addon-search`) adds a decoration per match, each
tied to a marker on its buffer line. When the line goes away first (the
activation refresh's `terminal.reset()`, Cmd+K, `clear`, or scrollback
trimming), the marker's line becomes -1 before the decoration is disposed.
`SortedList.delete` looks decorations up by that line, misses, and the
decoration service never drops it, so its highlight stays painted on screen
for the life of the terminal.

The patch, in both `lib/` bundles:

1. Renames `SortedList.delete` to `_deleteByKey` and makes `delete` fall back
   to finding the value by identity when the keyed lookup misses.
2. Makes `buffer.getLine(y)` return undefined for a row outside the buffer,
   as its typings say. It read the circular list's backing array without a
   bounds check, so after `clear` it returned stale rows from earlier output,
   and the search addon joined a stale soft-wrapped row onto the last line
   (find showed "0 of N" after wrapping past the last match).
   `frontend/src/components/terminal/xtermBufferBounds.test.ts` covers it. Regenerate it the same way as the WebGL patch
when bumping `@xterm/xterm`, after checking whether upstream fixed
`SortedList.delete` (or `DecorationService`'s dispose path) and
`BufferApiView.getLine` itself.
