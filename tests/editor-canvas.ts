import type { Page } from '@playwright/test';

/**
 * Editor canvas geometry for turning a tick and lane into a mouse position.
 * Read it again for every point: picking a tool can wrap the tool row (CI renders CJK labels wider), which moves the
 * canvas at once and resizes it only when the editor's ResizeObserver runs on the next frame. Waiting two frames lets
 * that resize finish, so the position matches what the editor will compute for the event.
 */
export async function canvasGeometry(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const canvas = page.locator('.editor-viewport canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('editor canvas is not visible');
  return {
    box,
    trackLeft: Number(await canvas.getAttribute('data-track-left')),
    laneWidth: Number(await canvas.getAttribute('data-lane-width')),
    zoom: Number(await page.locator('[data-option="zoom"]').inputValue()),
  };
}
