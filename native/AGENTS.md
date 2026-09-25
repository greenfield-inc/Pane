# Pane native app conventions

Read `README.md` first for running, testing and the folder map.

## Expo changes every SDK

This is Expo SDK 57. Check APIs against https://docs.expo.dev/versions/v57.0.0/ (and https://docs.expo.dev/llms.txt) instead of memory. The workspace enforces a 7-day minimum release age, so `npx expo install` can pick a version pnpm refuses; add the package with `pnpm add <pkg>@~57.0.0` (or the version from `npx expo install --check`) instead.

## Rules

- Routes live in `src/app/`. Keep components, hooks and logic in `src/features/<area>/`.
- Business logic goes in plain TS modules with no React Native imports, tested with Vitest (`src/**/*.test.ts`). Components stay thin.
- React Compiler is on. Do not add `useMemo`, `useCallback` or `React.memo` by hand. Derive values during render; use effects only to sync with outside systems.
- Every scrolling list uses Legend List (`@legendapp/list/react-native`), not `FlatList` or `ScrollView` over data.
- Animations and gestures use Reanimated and Gesture Handler on the UI thread, never React state.
- Use `@/ui` components and `useTheme()` tokens. No hard-coded colors outside `src/theme/`. Support light and dark.
- Daemon calls go through `useInvokeQuery` / `useInvokeMutation` / `invokeChannel`, which unwrap the desktop IPC `{ success, data }` envelope. Query keys start with the host's profile ID (`useDaemonQueryKey`).
- Mutations are never retried automatically. A `RemoteUnconfirmedResultError` means the host may have applied it: refetch and show the state.
- Live updates come from `useDaemonEvent(channel, handler)`. The stream does not replay missed events; `DaemonProvider` refetches every query on reconnect.
- The bearer token only travels in headers. Never put it in a URL, a log or a push payload.
- Give interactive elements a `testID` so Maestro flows can find them.
- Stacks use `fullScreenGestureEnabled` (swipe back from anywhere). Don't put a horizontal gesture on a pushed screen's left edge without checking it still swipes back.
- Native config goes in `app.json` or config plugins. `ios/` and `android/` are generated and ignored.
