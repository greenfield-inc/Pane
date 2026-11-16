import { expect, test } from '@playwright/test';

declare global {
  interface Window { customThemeCssTest: { apply: (css: string) => string } }
}

// The renderer's filter is the only guard against Custom CSS fetching a file (Pane sets no CSP), so these
// run it in Chromium, which parses the CSS the way the app does.
test.describe('Custom theme CSS filter', () => {
  const requests: string[] = [];
  const apply = async (page: import('@playwright/test').Page, css: string) => {
    await page.goto('/renderer-tests/custom-theme-css.html');
    return page.evaluate((text) => window.customThemeCssTest.apply(text), css);
  };
  test.beforeEach(({ page }) => {
    requests.length = 0;
    page.on('request', (request) => requests.push(request.url()));
  });

  test('drops an escaped remote url and keeps the rest of the rule', async ({ page }) => {
    const kept = await apply(page, '.a { background-image: u\\72 l(https://example.com/a.png); --later: u\\72 l(https://example.com/b.png); color: red; }');
    expect(kept).toContain('color: red');
    expect(kept).not.toContain('example.com');
    expect(requests.filter((url) => url.includes('example.com'))).toEqual([]);
  });

  test('drops image-set and every @font-face', async ({ page }) => {
    const kept = await apply(page, '.a { background-image: image-set("https://example.com/a.png" 1x); color: blue; } @font-face { font-family: x; src: url(https://example.com/x.woff2); }');
    expect(kept).toBe('.a { color: blue; }');
  });

  test('filters inside nested @media and @layer rules', async ({ page }) => {
    const kept = await apply(page, '@media (min-width: 1px) { @layer theme { .a { background: url(https://example.com/a.png); color: green; } } }');
    expect(kept).toContain('color: green');
    expect(kept).not.toContain('example.com');
  });

  test('keeps data: images and #id references', async ({ page }) => {
    const kept = await apply(page, '.a { background-image: url("data:image/png;base64,iVBORw0KGgo="); } .b { filter: url(#shadow); }');
    expect(kept).toContain('url("data:image/png;base64,iVBORw0KGgo=")');
    expect(kept).toContain('url("#shadow")');
  });

  test('accepts @namespace without throwing', async ({ page }) => {
    const kept = await apply(page, '@namespace svg "http://www.w3.org/2000/svg"; .a { color: red; }');
    expect(kept).toContain('color: red');
  });
});
