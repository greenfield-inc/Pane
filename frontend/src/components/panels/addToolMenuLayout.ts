/** The Add tool menu's width when the viewport has room for it. */
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
  width: number;
}

/**
 * Where the Add tool menu sits: under its "+" button, moved left as far as it
 * takes to keep the whole menu inside the viewport's margins.
 */
export function placeAddToolMenu({ anchorLeft, viewportWidth }: {
  anchorLeft: number;
  viewportWidth: number;
}): AddToolMenuPlacement {
  const width = Math.min(
    ADD_TOOL_MENU_WIDTH,
    viewportWidth - (ADD_TOOL_MENU_VIEWPORT_MARGIN * 2),
  );
  const left = Math.max(
    ADD_TOOL_MENU_VIEWPORT_MARGIN,
    Math.min(anchorLeft, viewportWidth - width - ADD_TOOL_MENU_VIEWPORT_MARGIN),
  );
  return { left, width };
}
