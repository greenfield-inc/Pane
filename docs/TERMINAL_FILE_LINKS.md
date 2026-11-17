# Terminal file links

Ctrl-click a detected file path (Cmd-click on macOS) to open its actions. Files
inside the pane's worktree can open in an editor tab. Paths outside the worktree
are labelled as such and cannot open in the worktree editor; local sessions can
still reveal them in the system file manager.

`resolveTerminalPath` is shared by detected links and selected-text actions. It
keeps the absolute path for tooltips and native file-manager actions separate
from the relative path required by `file:exists` and `openFileInEditor`. It
normalizes `.` and `..` segments and converts Linux paths to the worktree's WSL
UNC namespace when appropriate.

`terminal:getPathContext` gets the worktree and home directory from the session's
daemon host. WSL sessions read `HOME` asynchronously inside their distribution.
`~/` is never inferred from the worktree. If home cannot be resolved, home-relative
actions stay disabled. Remote sessions continue to disable native file-manager
actions.

The xterm link-provider line number is one-based; the terminal buffer's
`getLine` index is zero-based.

## Custom links

Settings › Links turns text matching your own regular expressions into links,
such as issue keys opening your tracker. Each entry has a pattern and a URL
template that must start with `http://` or `https://`; `$0` inserts the whole
match and `$1` to `$9` insert capture groups, URL-encoded. Cmd-click (Ctrl-click
on Windows and Linux) opens the link. File, URL and git links keep working
alongside. Entries travel with Settings › Import & Export.

Patterns run in a web worker (`frontend/src/utils/customLinkMatcher.ts`), one
terminal row at a time with trailing padding trimmed. A row that takes longer
than `CUSTOM_LINK_MATCH_TIMEOUT_MS` stops the worker and gets no custom links,
so a pattern that backtracks badly can't freeze the window.
