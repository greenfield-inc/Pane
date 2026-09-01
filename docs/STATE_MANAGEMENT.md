# State Management Guidelines

⚠️ **IMPORTANT**: Pane follows a targeted update pattern for state management to minimize unnecessary re-renders and network requests.

## Overview

Pane uses a combination of Zustand stores, IPC events, and targeted updates to manage application state efficiently. The application prioritizes specific, targeted updates over global refreshes to improve performance and user experience.

Session and project lists live in Zustand (`frontend/src/stores/sessionStore.ts` and related stores). Do not keep a parallel `projectsWithSessions` array in a tree component; `DraggableProjectTreeView` was removed.

## Key Principles

1. **Targeted Updates**: Always update only the specific data that changed
2. **Event-Driven Updates**: Use IPC events to communicate changes between processes
3. **Avoid Global Refreshes**: Never reload entire lists when only one item changes
4. **Database as Source of Truth**: Frontend state should reflect backend state, not override it

## State Update Patterns

### Session Updates

```typescript
// ❌ BAD: Global refresh
const handleSessionCreated = () => {
  void loadSessions(); // Reloads everything
};

// ✅ GOOD: Targeted store update
const handleSessionCreated = (newSession: Session) => {
  useSessionStore.getState().addSession(newSession);
};
```

IPC handlers in `useIPCEvents` already call `addSession` / `updateSession` / `deleteSession` on the store. Subscribe with selectors (`useSessionStore(s => s.sessions)`) instead of copying the list into local React state.

### Main Repo Sessions Are Stored Twice

A repository's main repo session lives in **two** places in `sessionStore`: in the
`sessions` array (which the sidebar renders) and in `activeMainRepoSession` (which
the project view reads) while it is active. Any writer that touches a session must
update **both** copies, or one surface renders stale data.

```typescript
// ❌ BAD: returns early, leaving the sidebar's copy stale
if (state.activeMainRepoSession?.id === updated.id) {
  return { ...state, activeMainRepoSession: { ...state.activeMainRepoSession, ...updated } };
}
// ...never reached for the main repo session
return { ...state, sessions: updateInList(state.sessions, updated) };

// ✅ GOOD: both copies move together
const newActiveMainRepoSession = state.activeMainRepoSession?.id === updated.id
  ? { ...state.activeMainRepoSession, ...updated }
  : state.activeMainRepoSession;
return {
  ...state,
  sessions: updateInList(state.sessions, updated),
  activeMainRepoSession: newActiveMainRepoSession,
};
```

`updateSession` and `updateSessionGitStatus` both follow the second shape. Regression
coverage lives in `tests/sidebar-rename-pane.spec.ts`, which renames an active main
repo pane and asserts the sidebar label changes.

### Project Updates

```typescript
// ❌ BAD: Reload all projects
const handleProjectDeleted = () => {
  fetchProjects(); // Network request for all projects
};

// ✅ GOOD: Remove from local state
const handleProjectDeleted = () => {
  setProjects(prev => prev.filter(p => p.id !== deletedId));
};
```

## IPC Event Handling

The application uses IPC events to synchronize state between the main process and renderer:

### Session Events

- `session:created` - Add new session to appropriate project
- `session:updated` - Update specific session properties
- `session:deleted` - Remove session from project list

### Project Events

- `project:updated` - Update specific project properties

## When Global Refreshes Are Acceptable

- **Initial Load**: When component mounts for the first time
- **User-Triggered Refresh**: When user explicitly requests a refresh
- **Error Recovery**: After connection loss or critical errors
- **Complex State Changes**: When multiple interdependent items change

## Implementation Examples

### ProjectSessionList.tsx

- Reads sessions from Zustand `sessionStore`
- IPC events patch the store; the tree re-renders from selectors
- Avoids a local `projectsWithSessions` array that new-references on every status tick

## Best Practices

1. **Use Store Actions**: Call `useSessionStore.getState().addSession(...)` (or the matching action) from IPC handlers so every subscriber sees one update
2. **Merge Updates**: When updating objects, spread existing properties to preserve data
3. **Handle Edge Cases**: Always check if the item exists before updating
4. **Log State Changes**: Add console logs for debugging state updates in development
5. **Validate IPC Data**: Ensure IPC events contain expected data structure
