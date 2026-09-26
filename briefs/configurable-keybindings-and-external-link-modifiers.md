# Implementation brief: one configurable shortcut model and consistent link modifiers

**Baseline:** `origin/main` at `169f8aa3` (`release: v2.4.87`, fetched 2026-08-29)<br>
**Workstream:** global Pane shortcut mapping, configurable agent-launch bindings, and consistent modified-click link opening

## Outcome at a glance

Implement one global, persistent Pane keybinding model that:

- Defines application-command defaults in a shared catalog and stores only explicit overrides or unassignments.
- Lets users remap every cataloged application command, including supported agent-launch commands, while including dynamic snippet and custom-command bindings in conflict detection.
- Uses the same effective binding for Settings and Help displays, renderer dispatch, terminal release, and embedded-browser forwarding.
- Rejects ambiguous conflicts between commands that can be active together instead of resolving them by registration order.
- Centralizes terminal-link routing so the platform primary modifier opens HTTP(S) externally and primary-modifier+Shift opens it in Pane's Browser when that surface is available.

### Terms used throughout

- **Cataloged command:** a registry-backed Pane action whose identity, metadata, and default chord live in the shared catalog.
- **Effective binding:** a command's explicit override, explicit unassignment, or catalog default, in that order.
- **Activation scope:** the contexts in which a command can run. A duplicate chord is a conflict only when the commands' scopes overlap.

## Approved product decisions

- “Global” means one setting per Pane data directory, shared by all saved repositories and worktrees, not a system-global accelerator.
- All registry-backed Pane commands are editable. Terminal-, native-, and context-only shortcuts appear as a complete read-only reference unless separately moved into the registry.
- A command may be explicitly unassigned; reset is distinct from unassign. Existing chord reuse is valid only for provably non-overlapping activation scopes.
- Remote PWA keyboard remapping is outside this desktop workstream.
- Command is the primary modifier on macOS; Control is primary on Windows/Linux. Primary-click opens a terminal HTTP(S) link externally, while primary+Shift opens it in Pane's Browser when that surface is available. On macOS, an unconsumed Control-click may remain an external-browser alias, but must not suppress the native context-click gesture.
- Existing provider-specific plain-click behavior remains unchanged, including OSC-8's plain-click external activation. The more-specific primary+Shift route always wins over external routing.

## Problem

Users cannot remap the shortcuts that start supported agent terminals. Pane also has no complete settings view of its application shortcuts: bindings are declared where actions mount, Help reflects only the current runtime registry, conflicts are resolved implicitly, and there is no reset-to-default path. Terminal links also lack a single platform-aware router that can distinguish external opening from opening inside Pane, preserve provider-specific plain clicks, and avoid duplicate activation.

This is a root-cause workstream, not three isolated UI patches. The underlying problems are:

1. Shortcut identity, defaults, effective user bindings, active actions, conflict policy, terminal interception, webview forwarding, and presentation are separate sources of truth.
2. Modified-click policy is repeated in multiple terminal link implementations, and Pane Chat inherits those inconsistencies through its terminal panel.

A patch that only makes `AGENT_LAUNCH_PRESETS[*].hotkey` editable or adds `event.ctrlKey` to one callback would fix symptoms but leave remapped shortcuts unreliable whenever focus is in xterm or an embedded browser.

## Current-state evidence

| Area | Evidence on `origin/main` | Consequence |
| --- | --- | --- |
| Supported agents/defaults | `shared/constants/agentLaunchPresets.ts:1-55` defines Claude, Codex, and Cursor plus hard-coded `mod+alt+3/4/5`; Cursor is unavailable only for native Windows. `main/src/services/agents/agentLaunchPresets.test.ts:9-33` pins the agents and commands to the RunPane contract. | Agent launch metadata and default keys are coupled. |
| Agent launch/action | `frontend/src/components/SessionView.tsx:1232-1255` registers each visible preset directly from `preset.hotkey`; `:1248-1251` creates the terminal with the preset command/title. `frontend/src/components/ProjectView.tsx:218-270` has its own option-aware panel creator but exposes only `addTerminal` through the current bridge. | No override is resolved, and agent-launch behavior in the separately rendered main-repo view needs an explicit shared action/verification path. |
| Shortcut displays | `frontend/src/components/SessionView.tsx:1156-1198` and `frontend/src/components/panels/PanelTabBar.tsx:654-676` read the mounted registry to show keys. `frontend/src/components/Help.tsx:8-64` does the same and contains one separately hard-coded contextual shortcut. | Settings/Help cannot show a stable, complete map independent of the current view. |
| Runtime collision policy | `frontend/src/stores/hotkeyStore.ts:224-236` rebuilds a single `chord -> id` map; a later registration overwrites an earlier one, with a warning only in development. | A conflict can silently run the wrong command in production. |
| Existing settings/persistence | `frontend/src/components/settings/categories/ShortcutsSettings.tsx:18-177` can toggle all Pane shortcuts and edit terminal snippet letters, detecting duplicates only among those snippets. `frontend/src/types/config.ts:54-155`, `frontend/src/stores/configStore.ts:24-67`, and `main/src/services/configManager.ts:41-118,148-185,315-356` provide global JSON config loading/merging/saving. | There is an appropriate global persistence owner, but no application-keybinding model or reset semantics. |
| Dynamic conflict participants | `frontend/src/hooks/useTerminalShortcuts.ts:18-40` registers snippets as `mod+alt+<letter>`. `frontend/src/components/SessionView.tsx:1257-1270` assigns custom commands `mod+alt+6..9`. | Agent remaps must be checked against bindings outside the static agent list. |
| Intentional scoped reuse | Run Dev Server uses `mod+shift+d` in `frontend/src/components/panels/PanelTabBar.tsx:348-401`; Usage Download uses the same chord in `frontend/src/components/usage/UsageView.tsx:260-274`. | Conflict detection needs explicit activation scopes; a global duplicate-string ban would reject an existing valid default. |
| Terminal interception | `frontend/src/components/panels/TerminalPanel.tsx:1016-1157` contains a long hard-coded release list, while `frontend/src/utils/terminalKeyHandling.ts:64-124` separately recognizes selected Pane chords in TUIs. | An arbitrary remap can be consumed by xterm/the CLI instead of reaching the hotkey registry. |
| Embedded-browser interception | `main/src/index.ts:446-510` forwards a hard-coded whitelist plus broad `mod+alt` patterns from webviews; the renderer receives them through `main/src/preload.ts:333-352`. The disabled-shortcut Command Palette exception is itself hard-coded to Shift+P in `main/src/utils/keyboardShortcuts.ts:15-22`. | A remap outside those patterns stops being global while a browser panel has focus, or forces Pane to intercept unrelated browser shortcuts. |
| Terminal and chat links | `frontend/src/components/panels/TerminalPanel.tsx:991-997,1185-1198` owns OSC-8 and auto-detected HTTP(S) activation. OSC-8 currently opens on every activation; auto-detected URLs require `metaKey` on macOS or `ctrlKey` elsewhere. Git SHA/issue providers build HTTPS URLs and repeat the modifier gate (`frontend/src/components/terminal/linkProviders/gitLinkProvider.ts:35-115`; `main/src/ipc/git.ts:2056-2084`). File links are a separate provider whose modified click opens a file-action popover rather than a URL (`frontend/src/components/terminal/linkProviders/fileLinkProvider.ts:96-137`). Pane Chat renders the same `TerminalPanel` path (`frontend/src/components/PaneChatView.tsx:164-168`; `frontend/src/components/panels/PanelContainer.tsx:48-52`). | Routing is fragmented, and URL versus file-link behavior must stay distinct. |
| Existing in-Pane browser path | Terminal text selection already reuses or creates a Browser panel, activates it, and emits `browser-panel:navigate` (`frontend/src/components/terminal/hooks/useTerminalLinks.ts:194-234`). `BrowserPanel` also observes panel state and the custom event (`frontend/src/components/panels/browser/BrowserPanel.tsx:94-116,279-301`), so the current path can update and then reload/navigate the same URL twice. | Modified-click should use one session-scoped orchestration path with one terminal activation and one Browser navigation. |
| Browser availability and schemes | Browser panels are declared worktree-only (`shared/types/panels.ts:358-366`) and filtered from Project view (`frontend/src/components/panels/PanelTabBar.tsx:403-426`); Pane Chat renders only its one terminal (`frontend/src/components/PaneChatView.tsx:164-168`). `BrowserPanel` accepts `http:`, `https:`, and trusted `file:` flows (`frontend/src/components/panels/browser/BrowserPanel.tsx:94-110`), while xterm's OSC-8 provider and the Web Links addon admit HTTP(S) by default. | The gesture can safely target HTTP(S) in worktree Browser panels; Project and Pane Chat need an explicit fallback, and terminal output must not gain access to trusted local-file preview behavior. |
| Browser security boundary | Every attached webview has preload removed, Node disabled, context isolation enabled, and sandboxing enforced in `main/src/index.ts:382-388`. Browser cookies/storage are partitioned by project in `frontend/src/components/panels/browser/BrowserPanel.tsx:421-428`; popup routing is registered by session/panel in `main/src/index.ts:390-428` and `main/src/ipc/panels.ts:890-895`. | Reuse the existing Browser panel and its isolation; do not create a new webview path or weaken its session routing. |
| External browser boundary | Renderer calls converge on `openExternal`; `main/src/ipc/app.ts:70-90` uses native `open` on macOS and `shell.openExternal` elsewhere. | External routing remains behind the existing main-process boundary; the terminal gesture router accepts only validated HTTP(S) sources before invoking it. |

## Design decisions

### 1. One catalog and one effective-binding resolver

- Add a shared, typed catalog for every registry-backed Pane command: stable id, label, category, activation scope, default chord, platform/environment availability, and whether the row is user-editable. Generate numbered families (pane switching and tab switching) rather than duplicating literals.
- Keep actions in renderer components, but register them by catalog id. The registry resolves `effective chord = explicit override | unassigned | catalog default`; registrations no longer own defaults.
- Keep agent command/title/platform data in `AGENT_LAUNCH_PRESETS`, but make each preset reference its catalog shortcut id. Remove the duplicate hotkey value from the preset.
- Persist sparse global overrides in `AppConfig` as `keyboardShortcutOverrides` keyed by stable command id. Missing key means “follow the current default”; `null` means explicitly unassigned. Per-row Reset deletes one override; Reset all deletes the override map.
- Preserve Pane's portable `mod` abstraction (Command on macOS, Control on Windows/Linux). Literal Control-vs-Command bindings on macOS, multi-step chords, and OS-global accelerators are not introduced by this workstream.

### 2. Complete settings/reference surface

- Replace the current “View all” runtime snapshot with a searchable, category-grouped map sourced from the catalog plus current dynamic bindings. Show command, effective chord, default chord, availability/scope, and customized/conflict state.
- Make all cataloged application commands rebindable or unassignable, including Claude, Codex, and Cursor launch commands. Keep terminal snippet content/key editing in its existing section, but include snippets and generated custom-command bindings in the map and conflict engine.
- List contextual/native shortcuts that are not global-registry commands (for example terminal copy/search/clear and submit/continue) as read-only reference rows rather than pretending they are remappable.
- Use an accessible key recorder. Canonicalize modifier order/case and physical-key handling with the same pure normalizer used at runtime. Reject modifier-only input, bare printable keys that would break typing, unsupported sequences, and malformed external config values.
- Block Apply while two commands with overlapping activation scopes share a normalized chord. Identify both commands inline. Scoped duplicates that provably cannot coexist remain valid. Backend/config validation repeats the check; if hand-edited config creates an active ambiguity, execute neither command and surface/log the conflict instead of choosing by registration order.
- Help, Command Palette, tool menus, empty states, and shortcut hints consume the same effective binding. Unassigned commands remain available from click/palette surfaces without a key label.

### 3. Make remaps work in every existing focus path

- Replace the hotkey store's last-registration-wins index with `chord -> candidate ids`; select exactly one currently enabled candidate or no-op on ambiguity.
- Replace TerminalPanel's command-by-command release list with a query against the active effective registry after terminal-owned editing/clipboard/search behavior has had its documented precedence. Retain AltGr, international-layout, SIGQUIT, TUI, and modal protections.
- Extract webview matching/forwarding into a pure main-process helper built from the effective shared catalog and current config. Forward only exact configured Pane chords, update immediately after config changes, and resolve the Command Palette exception from its effective binding. Do not broaden interception to all modified keys.
- “Global” means one Pane configuration across repositories/worktrees and consistent handling in renderer, xterm, and embedded-browser focus. It does not mean an OS-level shortcut while Pane is unfocused. Agent creation remains available only in a view that can create a terminal, matching current behavior.

### 4. One ordered router for terminal HTTP(S) links

- Add one pure event classifier and one session-aware URL router used by xterm's auto-detected HTTP(S) callback, OSC-8 handler, and git SHA/issue links. Classify a single activation in this order, with no fallthrough:
  1. **Primary+Shift:** Command+Shift on macOS; Control+Shift on Windows/Linux. Open in Pane's Browser when the current view has an eligible worktree Browser surface.
  2. **Primary:** Command on macOS; Control on Windows/Linux. Open through the existing `openExternal` IPC.
  3. **macOS Control alias:** open externally only when xterm/Chromium delivers it as an unconsumed primary-button activation. Never prevent or replace a native `contextmenu`/secondary-click event.
  4. **No qualifying gesture:** preserve the provider's current behavior—OSC-8 opens externally; auto-detected and git-reference links do nothing.
- Treat a URL gesture as a single consumed routing decision. Primary+Shift must never also reach the external branch, and overlapping xterm providers must not each act on the same click. The router owns one terminal activation id/outcome and invokes exactly one destination.
- For in-Pane opening, validate an absolute URL with the platform `URL` parser and allow only `http:` or `https:` before any panel mutation. Supported inputs are auto-detected HTTP(S), HTTP(S) OSC-8, and HTTPS git commit/issue links. Reject `file:`, `javascript:`, `data:`, `blob:`, custom schemes, credentials-bearing URLs, and malformed input from this gesture path. File-path links retain their current modified-click file popover and never route to either browser.
- Reuse the current session's first Browser panel or create and activate one through `panelApi`; preserve its existing project partition and hardened webview. Replace the current state-update-plus-`browser-panel:navigate` combination with one authoritative create-or-navigate operation so an existing URL is not also reloaded by a duplicate event.
- A Browser surface is available only in an ordinary worktree Session that permits Browser panels. In Project/main-repo terminals, Pane Chat, Remote PWA, or any context that cannot visibly host and activate a Browser panel, Primary+Shift falls back to `openExternal` exactly once; it must not create a hidden/disallowed panel. If an eligible internal open has an indeterminate partial failure, report/log the failure without also opening externally; fallback is only for known-unavailable surfaces or a failure confirmed before mutation.
- Add consistent provider hover text using platform glyphs/names. When Browser is available, gated URL links show “⌘+Click: external · ⇧⌘+Click: Pane Browser” on macOS and “Ctrl+Click: external · Ctrl+Shift+Click: Pane Browser” elsewhere; OSC-8 prefixes the existing “Click: external” behavior. When unavailable, say that Pane Browser is unavailable here and advertise external opening only. Do not advertise the macOS Control-click compatibility alias because native context-click takes precedence.

## Scope

- Shared command catalog, binding/event normalization, effective binding resolution, activation scopes, and conflict detection.
- Global config types, normalization/validation, persistence, change propagation, and reset semantics.
- Complete Shortcuts settings/reference UI and all current effective-key display consumers.
- Configurable launch bindings for every contract-backed supported agent, with current environment availability preserved.
- Renderer hotkey dispatch, terminal/TUI release, and embedded-webview forwarding driven by effective bindings.
- Ordered modified-click routing for terminal HTTP(S)/git links, Browser-panel reuse/creation where supported, safe external fallback elsewhere, and the Pane Chat terminal path.
- Unit, component, Playwright/Electron, and manual cross-platform coverage; update `docs/ADDING_NEW_CLI_TOOLS.md` so new agents must add catalog metadata and tests.

## Non-goals

- System-wide/global shortcuts when Pane is not focused.
- Per-project, per-pane, per-agent-profile, or cloud-synced keybinding profiles.
- Multi-key sequences, multiple alternate bindings per command, arbitrary macros, or importing VS Code keymaps.
- Redesigning terminal-native editing keys, Monaco/browser-native shortcuts, or Remote PWA touch controls.
- Changing agent commands, agent availability, Pane Chat's default-agent selector, RunPane's public contract, or custom-command execution.
- Broadening Pane Browser's scheme support, exposing trusted `file:` preview to terminal output, or changing the main-process external-browser launcher.
- Making ordinary React `<a>` elements require a modifier; this work targets terminal/chat link activation paths.
- Changing file-path link activation/popovers or the user-visible semantics of selection-popover buttons; they are not part of the modified-click URL gesture, though “Open in Browser” should reuse the same single-navigation helper.

## Acceptance criteria

1. Shortcuts Settings shows the same complete catalog regardless of the current Pane view, with effective/default bindings and clear unavailable/read-only/customized states.
2. Claude and Codex can be remapped globally on every supported desktop environment; Cursor can be remapped and launched on macOS, Linux, and WSL, and remains unavailable for native Windows projects.
3. Saving an agent remap changes dispatch and every displayed hint without restart. The previous chord stops launching it; the new chord creates exactly one terminal with the existing preset title and command in worktree and main-repo Pane views.
4. A remapped command works while focus is in ordinary renderer UI, a CLI/TUI terminal, and an embedded browser webview, subject to its declared activation scope.
5. Conflicts are detected against overlapping built-in commands, other agent commands, terminal snippets, and generated custom-command bindings. Apply is blocked with both owners named; production dispatch never silently picks the last registration.
6. Per-command Reset and Reset all restore catalog defaults immediately and remove sparse overrides rather than copying default strings into config. An unassigned command has no active chord but remains clickable/searchable.
7. The all-shortcuts enable toggle and the Command Palette exception retain their behavior with remapped bindings; disabled shortcuts are not swallowed by terminal/webview interception.
8. Existing installs with no override field retain byte-for-byte effective shortcut behavior, including scoped duplicate defaults, AltGr safeguards, international keyboard handling, and platform display glyphs.
9. For validated HTTP(S) auto-detected, OSC-8, and git-reference links, Command-click on macOS and Control-click on Windows/Linux open the external browser exactly once; Meta-click alone does nothing on Windows/Linux. An unconsumed macOS Control-click may do the same, but native context-click remains intact. Auto-detected/git plain clicks remain inactive, OSC-8 plain click still opens externally, and file-path links retain their existing popover behavior.
10. Primary+Shift takes precedence and opens each supported HTTP(S) link exactly once in the visible Browser panel of an eligible worktree Session, reusing the first Browser panel or creating/activating one without a duplicate state update, custom event, reload, or external open. The gesture rejects malformed, credential-bearing, local-file, and non-HTTP(S) targets before panel mutation. In Project/main-repo terminals, Pane Chat, Remote PWA, and any known Browser-ineligible context, it opens externally exactly once and creates no hidden Browser panel; hover text accurately describes the available platform gestures and fallback.
11. Help, Command Palette, Add Tool, and empty-state agent entries all display the effective remapped or reset chord and never show stale preset constants.

## Test and QA plan

### Automated

- Shared/unit: catalog id/default uniqueness; RunPane agent parity; platform availability; event/string normalization for letters, shifted digits, punctuation, arrows, Backslash/IntlBackslash, Command/Control, and AltGr; override fallback/unassign/reset; activation-scope conflict matrix.
- Store/unit: zero/one/multiple enabled candidates; conflicts no-op rather than last-wins; disabled-shortcut and remapped Command Palette exception behavior.
- Main/unit: extract and test exact webview forwarding from effective bindings, including config updates, disabled shortcuts, native browser shortcuts, shifted physical codes, and AltGr.
- Terminal/unit: effective remaps are released from xterm only when active; existing TUI, SIGQUIT, clipboard, search, paste, and international-layout cases remain green.
- Settings/Playwright: complete view-independent inventory; accessible key capture; dirty/save/error states; conflict owners; unassign; row reset; reset all; persistence after close/reopen; platform availability; snippet/custom-command conflicts; effective hints in Help and Add Tool.
- Launch integration: remap each supported agent, invoke from normal UI/terminal/webview focus, and assert one panel with the preset title/initial command in worktree and main-repo contexts.
- Link unit: classifier truth table for macOS Command/Command+Shift/Control/context-click and Windows/Linux Control/Control+Shift/Meta, including Shift precedence, primary-button filtering, provider-specific plain clicks, and file-link exclusion. URL fixtures cover HTTP/HTTPS, credentials, malformed strings, `file:`, `javascript:`, `data:`, `blob:`, and a custom scheme.
- Link integration: auto-detected, OSC-8, and git-reference providers each route one activation to one sink. Existing worktree Browser reuse/create/activate performs one navigation without `openExternal`; Project and Pane Chat Primary+Shift use one external fallback and create no Browser panel. Assert platform-specific hover copy and unchanged file popovers.

### Manual desktop QA

- macOS: US and one Option-sensitive layout; verify Command-click externally and Command+Shift-click in Pane Browser from a worktree terminal for auto-detected, OSC-8, and GitHub issue/commit links. Verify Pane Chat/Project fallback, OSC-8 plain click, file popovers, and that Control-click still opens the native context menu (or externally only when delivered as an ordinary unconsumed click).
- Windows native and WSL project; Linux: verify Control-click externally, Control+Shift-click in Pane Browser where eligible, external fallback elsewhere, Meta-click no-op, Cursor availability rules, AltGr entry, and remapped launch from xterm and an embedded browser.
- Restart Pane after saving, edit `config.json` externally once, and verify valid changes reload while malformed/conflicting values fail safe and remain diagnosable in Settings/logs.
- Keyboard-only and screen-reader pass for recording, error announcement, reset confirmation, focus restoration, 200% zoom, and narrow Settings layout.
- Required gates: targeted unit/Playwright suites, `pnpm lint`, and `pnpm typecheck`.

## Migration and backward compatibility

- No database migration. `keyboardShortcutOverrides` is optional in the existing global `config.json`; absence resolves to current defaults.
- Existing terminal snippets, custom commands, keyboard enablement, and Command Palette exception fields remain intact. They become inputs to the shared conflict resolver, not rewritten records.
- Invalid or unknown override ids from hand edits/newer versions are preserved in config for forward/downgrade tolerance but ignored by the current runtime with a diagnostic. Invalid chord syntax falls back safely; an active duplicate invokes neither action.
- Sparse overrides deliberately follow future default changes only when the user has not customized that command. Reset removes an override so future defaults apply; explicit custom/unassigned values survive upgrades.
- Stable ids are the compatibility boundary. Renaming labels or changing agent titles must not rename ids; removing an agent must not reuse its id.

## Risks and mitigations

- **Catalog drift:** a command could register without settings metadata. Make catalog membership type-checked for static commands and test dynamic id families; fail tests on unmatched registrations.
- **Scope mistakes:** incorrectly declaring two commands mutually exclusive could hide a real conflict. Keep a small explicit scope model, default unknown/dynamic commands to the broadest scope, and test every intentional duplicate.
- **Terminal regressions:** generalized matching could swallow CLI keys. Keep terminal-native precedence and the current AltGr/TUI/layout regression suite; only release an exact, enabled effective Pane chord.
- **Webview regressions:** broad interception breaks browser editing/navigation. Match the exact effective set and add negative tests for Ctrl/Cmd+A/F/R and disabled commands.
- **Cross-process drift:** DOM and Electron keyboard events differ. Share pure canonicalization primitives and run the same fixture matrix against both adapters.
- **Recorder accessibility/layout:** key capture can trap focus or hide validation. Provide explicit Record/Clear/Reset controls, live conflict announcements, Escape cancel, and non-color status text.
- **Link double activation:** OSC-8, WebLinks, provider callbacks, panel-state effects, and `browser-panel:navigate` can overlap. Use one ordered classifier and one result-bearing navigation entry point; test sink call counts and remove the redundant update/event path.
- **Untrusted terminal URLs:** Pane Browser also supports trusted local HTML previews, but terminal output is untrusted. Admit only parsed HTTP(S) without embedded credentials to the in-Pane gesture and retain the existing sandbox, context isolation, project partition, and popup routing.

## Dependencies

- Existing Zustand hotkey registry, config store/IPC/`ConfigManager`, Settings persistence and dirty-form guard, xterm link APIs, Electron `before-input-event`, `panelApi`/Browser panel lifecycle, and `openExternal` IPC.
- `AGENT_LAUNCH_PRESETS` and the generated RunPane agent contract remain the source of truth for supported agent commands/platforms.
- No new runtime dependency is expected.
