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
  it('opens under the button when the viewport has room', () => {
    expect(placeAddToolMenu({ anchorLeft: 100, viewportWidth: 1280 }))
      .toEqual({ left: 100, width: ADD_TOOL_MENU_WIDTH });
  });

  it('moves left so the menu ends 8 px from the right edge', () => {
    expect(placeAddToolMenu({ anchorLeft: 1200, viewportWidth: 1280 }))
      .toEqual({ left: 1280 - ADD_TOOL_MENU_WIDTH - 8, width: ADD_TOOL_MENU_WIDTH });
  });

  it('narrows to the viewport minus its margins in a small window', () => {
    expect(placeAddToolMenu({ anchorLeft: 40, viewportWidth: 200 }))
      .toEqual({ left: 8, width: 184 });
  });
});
