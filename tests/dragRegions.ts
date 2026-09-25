import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Whether Electron would treat a window point as a drag handle. Electron walks
 * the page's `-webkit-app-region` boxes in document order and later boxes win
 * (drag adds, no-drag subtracts), so a control can lose to a drag area that
 * comes after it even when it paints on top.
 */
export function isDraggableAt(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(([px, py]) => {
    let draggable = false;
    for (const element of document.querySelectorAll('*')) {
      const region = getComputedStyle(element).getPropertyValue('-webkit-app-region');
      if (region !== 'drag' && region !== 'no-drag') continue;
      const box = element.getBoundingClientRect();
      if (px >= box.left && px < box.right && py >= box.top && py < box.bottom) draggable = region === 'drag';
    }
    return draggable;
  }, [x, y] as const);
}

/** Every listed control must receive clicks: no drag area wins over its center. */
export async function expectClickable(page: Page, controls: Locator[]): Promise<void> {
  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    if (!box) throw new Error('Control has no bounds');
    expect(await isDraggableAt(page, box.x + box.width / 2, box.y + box.height / 2), `${control} must not be a drag handle`).toBe(false);
  }
}
