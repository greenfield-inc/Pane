-- Handed-off panes (runpane panes handoff --park) keep their row and worktree but record
-- when the work moved to another runtime. NULL means the pane is not handed off.
ALTER TABLE sessions ADD COLUMN handed_off_at DATETIME;
