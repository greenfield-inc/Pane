# State Management Guidelines

⚠️ **IMPORTANT**: Pane follows a targeted update pattern for state management to minimize unnecessary re-renders and network requests.

## Overview

Pane uses a combination of Zustand stores, IPC events, and targeted updates to manage application state efficiently. The application prioritizes specific, targeted updates over global refreshes to improve performance and user experience.

Session and project lists live in Zustand (`frontend/src/stores/sessionStore.ts` and `frontend/src/stores/project-store.ts`). Do not keep a parallel `projectsWithSessions` array in a tree component; `DraggableProjectTreeView` was removed.

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

### Project Updates

App, Sidebar, HomePage, and notifications share `project-store.ts`. Read the list with `useProjectStore(s => s.projects)`; event handlers can read the latest value through `getState()`. Do not copy project lists into component state or notification caches.

`useIPCEvents` starts the initial load and subscribes once to `project:updated`, which calls the store's `upsert` action. Updates arriving during a list request take precedence over that request's older snapshot. The existing `project-changed` and `project-sessions-refresh` window events use one shared refresh path for additions, deletions, and reconnect recovery; concurrent initial reads share a request, and an invalidation during a pending request queues a fresh read. Failed reads retain the last usable list and expose `error`.

Use `ensureLoaded()` for startup decisions and `refresh()` when fresh server data is needed. Reordering uses `reorder(projectId, targetProjectId)`: it computes and persists an explicit order independently of React state updater timing, publishes the optimistic order to every subscriber, and rolls back on either an unsuccessful response or a rejected request. Rollback preserves project field updates received during the save. Only one reorder runs at a time; refreshes wait for its result.

## IPC Event Handling

The application uses IPC events to synchronize state between the main process and renderer:

### Session Events

- `session:created` - Add new session to appropriate project
- `session:updated` - Update specific session properties
- `session:deleted` - Remove session from project list

### Project Events

- `project:updated` patches the shared project store.
- Project creation/deletion currently use the legacy window refresh events described above; there are no dedicated preload events for them.

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
