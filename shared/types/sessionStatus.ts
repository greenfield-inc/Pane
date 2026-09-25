/**
 * Live status of a pane (session) as the main process and the renderer see it.
 * The database stores its own vocabulary (`Session['status']` in
 * main/src/database/models.ts); SessionManager maps between the two.
 */
export type SessionStatus = 'initializing' | 'ready' | 'running' | 'waiting' | 'stopped' | 'error';
