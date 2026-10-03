-- Record the successful once-only default-agent launch for a project.
ALTER TABLE projects ADD COLUMN default_agent_launched_at TEXT;
