/** The Add tool menu's narrowest width when the viewport has room for it. */
export const ADD_TOOL_MENU_WIDTH = 280;
/** The gap the Add tool menu keeps from each side of the viewport. */
export const ADD_TOOL_MENU_VIEWPORT_MARGIN = 8;
const MAX_CUSTOM_COMMAND_LABEL_LENGTH = 18;

/** Shortens a saved custom command's name for its Add tool menu row. */
export function truncateCustomCommandLabel(label: string): string {
  if (label.length <= MAX_CUSTOM_COMMAND_LABEL_LENGTH) return label;
  return `${label.slice(0, MAX_CUSTOM_COMMAND_LABEL_LENGTH - 3)}...`;
}

export interface AddToolMenuPlacement {
  left: number;
  minWidth: number;
  maxWidth: number;
}

/**
 * Where the Add tool menu sits and how wide it may grow. The menu takes the
 * width of its widest row: at least ADD_TOOL_MENU_WIDTH, at most the viewport
 * minus its margins. Shortcut hints are wider off macOS ("Ctrl+Alt+7" against
 * "⌘⌥7"), so a fixed width would leave a custom command's already shortened
 * label too little room and cut it a second time (#1562).
 *
 * `menuWidth` is the menu's rendered width; the menu opens under its "+"
 * button and moves left as far as it takes to stay inside the margins.
 */
export function placeAddToolMenu({ anchorLeft, viewportWidth, menuWidth }: {
  anchorLeft: number;
  viewportWidth: number;
  menuWidth: number;
}): AddToolMenuPlacement {
  const maxWidth = Math.max(0, viewportWidth - (ADD_TOOL_MENU_VIEWPORT_MARGIN * 2));
  const minWidth = Math.min(ADD_TOOL_MENU_WIDTH, maxWidth);
  const width = Math.min(Math.max(menuWidth, minWidth), maxWidth);
  const left = Math.max(
    ADD_TOOL_MENU_VIEWPORT_MARGIN,
    Math.min(anchorLeft, viewportWidth - width - ADD_TOOL_MENU_VIEWPORT_MARGIN),
  );
  return { left, minWidth, maxWidth };
}
