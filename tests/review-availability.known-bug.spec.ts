import { expect, test } from '@playwright/test';
import { baseGitStatus, openSession } from './reviewAvailabilityFixture';

// Out of CI (NOT_IN_CI in scripts/ci-test-inventory.mjs) until #1562 is fixed: off
// macOS the Add tool menu cuts long labels twice. Moved unchanged from
// review-availability.spec.ts (D-40), so the rest of that file runs in CI.

test('Add Tool keeps long custom commands inside a narrow viewport', async ({ page }, testInfo) => {
  const commandName = 'pnpm run extraordinarily-long-development-command';
  const fullCommand = `${commandName} --with-options`;
  const expectedLabel = `${commandName.slice(0, 15)}...`;

  await page.setViewportSize({ width: 420, height: 720 });
  await openSession(page, baseGitStatus, {
    expectInspector: false,
    initialConfig: {
      customCommands: [{ name: commandName, command: fullCommand }],
    },
  });

  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  const menu = page.getByRole('menu');
  const commandLabel = menu.getByText(expectedLabel, { exact: true });
  const commandButton = menu.getByRole('menuitem', { name: expectedLabel, exact: false });
  await expect(menu).toBeVisible();
  await expect(commandLabel).toBeVisible();
  await expect(commandLabel).toHaveText(expectedLabel);

  const menuBounds = await menu.boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.x).toBeGreaterThanOrEqual(8);
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(412);
  expect(await commandLabel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await commandButton.hover();
  await expect(page.getByRole('tooltip')).toContainText(fullCommand);
  const path = testInfo.outputPath('05-add-tool-responsive-command.png');
  await page.screenshot({ path });
  await testInfo.attach('05-add-tool-responsive-command.png', { path, contentType: 'image/png' });
});
