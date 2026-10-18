import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// The toolbar's playback rate: presets in the list, a custom value typed next to it, − / + stepping through presets from
// either, and both choices remembered across a reload. Runs against Vite; the shell works in the browser without Electron.
test(
  'toolbar playback rate takes a custom value and steps between presets',
  { skip: !process.env.CHUNI_UI_URL, timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CHUNI_BROWSER ? { executablePath: process.env.CHUNI_BROWSER } : {}),
      args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${process.env.CHUNI_UI_URL}/`);
      const select = page.locator('#playback-rate'),
        custom = page.locator('#playback-rate-custom'),
        up = page.locator('#playback-rate-up'),
        down = page.locator('#playback-rate-down');
      await page.evaluate(() => {
        localStorage.removeItem('playback-rate');
        localStorage.removeItem('playback-rate-custom');
      });
      await page.reload();
      assert.equal(await select.inputValue(), '1');
      assert.equal(await custom.isVisible(), false);
      // A custom rate: the field appears with the last custom value and keeps what is typed.
      await select.selectOption('custom');
      assert.equal(await custom.isVisible(), true);
      assert.equal(await custom.inputValue(), '1.00');
      await custom.fill('0.63');
      await custom.press('Enter');
      await custom.blur();
      assert.equal(await custom.inputValue(), '0.63');
      // Stepping from a custom value lands on the nearest presets and hides the field.
      await up.click();
      assert.equal(await select.inputValue(), '0.75');
      assert.equal(await custom.isVisible(), false);
      await down.click();
      await down.click();
      assert.equal(await select.inputValue(), '0.25');
      // Out-of-range typing is clamped when the field is left; the ends of the list stay put.
      await select.selectOption('custom');
      assert.equal(await custom.inputValue(), '0.63');
      await custom.fill('7');
      await custom.blur();
      assert.equal(await custom.inputValue(), '2.00');
      await up.click();
      assert.equal(await select.inputValue(), 'custom');
      assert.equal(await custom.inputValue(), '2.00');
      await custom.fill('0.4');
      await custom.blur();
      await page.reload();
      assert.equal(await select.inputValue(), 'custom');
      assert.equal(await custom.inputValue(), '0.40');
      await select.selectOption('1');
      await page.reload();
      assert.equal(await select.inputValue(), '1');
      assert.equal(await custom.isVisible(), false);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
