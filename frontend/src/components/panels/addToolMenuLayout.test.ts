import { describe, expect, it } from 'vitest';
import { ADD_TOOL_MENU_WIDTH, placeAddToolMenu, truncateCustomCommandLabel } from './addToolMenuLayout';

describe('truncateCustomCommandLabel', () => {
  it('keeps a name of 18 characters or fewer whole', () => {
    expect(truncateCustomCommandLabel('pnpm run dev')).toBe('pnpm run dev');
    expect(truncateCustomCommandLabel('a'.repeat(18))).toBe('a'.repeat(18));
  });

  it('cuts a longer name to 15 characters and an ellipsis', () => {
    expect(truncateCustomCommandLabel('pnpm run extraordinarily-long-development-command')).toBe('pnpm run extrao...');
  });
});

describe('placeAddToolMenu', () => {
  it('opens under the button at its narrowest width when its rows fit', () => {
    expect(placeAddToolMenu({ anchorLeft: 100, viewportWidth: 1280, menuWidth: 240 }))
      .toEqual({ left: 100, minWidth: ADD_TOOL_MENU_WIDTH, maxWidth: 1264 });
  });

  it('moves left so the menu ends 8 px from the right edge', () => {
    expect(placeAddToolMenu({ anchorLeft: 1200, viewportWidth: 1280, menuWidth: ADD_TOOL_MENU_WIDTH }).left)
      .toBe(1280 - ADD_TOOL_MENU_WIDTH - 8);
  });

  // #1562: off macOS a shortcut hint reads "Ctrl+Alt+7", so a custom command row
  // needs more than 280 px to show its shortened label without cutting it again.
  it('makes room for a row wider than 280 px and keeps the wider menu inside the viewport', () => {
    const placement = placeAddToolMenu({ anchorLeft: 300, viewportWidth: 420, menuWidth: 330 });
    expect(placement).toEqual({ left: 420 - 330 - 8, minWidth: ADD_TOOL_MENU_WIDTH, maxWidth: 404 });
  });

  it('caps the menu at the viewport minus its margins', () => {
    expect(placeAddToolMenu({ anchorLeft: 40, viewportWidth: 200, menuWidth: 330 }))
      .toEqual({ left: 8, minWidth: 184, maxWidth: 184 });
  });

  it('places a menu not yet measured at its narrowest width', () => {
    expect(placeAddToolMenu({ anchorLeft: 1200, viewportWidth: 1280, menuWidth: 0 }).left)
      .toBe(1280 - ADD_TOOL_MENU_WIDTH - 8);
  });
});
