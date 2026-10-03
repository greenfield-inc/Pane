# Dropdown menus

`frontend/src/components/ui/Dropdown.tsx` wraps Radix Dropdown Menu. Radix owns
keyboard navigation, disabled-item skipping, pointer focus, dismissal, trigger
focus restoration, portals, and collision-aware positioning. Pane supplies the
existing trigger and item styles, selection indicators, and shortcut labels.

An enabled `selectedId` receives initial focus by element identity. A missing or
disabled selection falls back to the first enabled menu item, including a footer
item in an otherwise empty menu. Selection does not follow focus; `onClick` only
runs on activation. `closeOnSelect={false}` keeps regular items open after
activation. `width="full"` matches the trigger through Radix's measured CSS
variable. The portal respects `PortalContainerProvider` for detached windows.

Footer actions should use `DropdownMenuItem`, so they participate in the same
roving focus collection and disabled-item handling as ordinary items. Native
button props and the optional icon are retained. A footer render callback still
receives `close` for flows that open another dialog.

When a menu action opens a Modal, the dialog uses the menu's ARIA-associated
trigger as its return-focus target; the transient menu item is removed on
selection.

The framework package is pinned to `@radix-ui/react-dropdown-menu@2.1.15`
(published 2025-05-20), installed under the workspace's seven-day minimum release
age. It matches the existing Dialog and Select primitive versions, adding only
Dropdown Menu, Menu, and Roving Focus (all MIT, with no install lifecycle scripts).
No existing locked package changes, release-age exceptions, or install-script
approvals are added. See the lockfile and `NOTICES` for exact dependencies and
license notices.

`tests/dropdown-keyboard-nav.spec.ts` exercises real browser focus and activation,
including selected rows after disabled rows, disabled selections, pointer hover,
keyboard wrapping, footer-only menus, Escape, outside clicks, keep-open selection,
and trigger-width positioning. The test fixture renders the production component;
there is no separate keyboard-navigation implementation to test.

The built renderer also uses the existing local monospace fallback stack without
a Google Fonts stylesheet import. An unavailable external stylesheet can reject
Vite's CSS preload and prevent the desktop bootstrap from mounting (#635).
