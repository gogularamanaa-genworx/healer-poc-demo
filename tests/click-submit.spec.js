const { test, expect } = require('@playwright/test');

test('user can submit the form', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Submit', { exact: true }).click();
  await expect(page.getByText('Submitted!')).toBeVisible();
});
