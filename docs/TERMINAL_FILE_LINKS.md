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
