import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_HTML = path.join(ROOT, 'dist', 'index.html');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

/** Wait for all artwork preview images to finish loading (if they have a src). */
async function waitForArtwork(page) {
  await page.evaluate(() => {
    const imgs = document.querySelectorAll('.art-preview');
    return Promise.all(Array.from(imgs).map(img => {
      if (!img.src) return Promise.resolve();
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(r => { img.onload = r; img.onerror = r; });
    }));
  });
}

function fileUrl(p) {
  return 'file://' + p;
}

test.beforeEach(async ({ page }) => {
  await page.goto(fileUrl(DIST_HTML));
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await page.evaluate(() => {
    let t = 0;
    performance.now = () => (t += 100);
  });
  // Switch to EBOOT tab
  await page.locator('[data-tab="eboot"]').click();
});

test('Multi-disc BIN drop → build EBOOT → download PBP', async ({ page }) => {
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-tab-initial.png');

  const disc1Path = path.join(FIXTURES, 'ps1-disc1.bin');
  const disc2Path = path.join(FIXTURES, 'ps1-disc2.bin');

  // Drop both disc BINs at once
  const input = page.locator('[data-testid="eboot-file-input"]');
  await input.setInputFiles([disc1Path, disc2Path]);

  // Wait for auto-detection to populate disc ID and artwork to render
  await expect(page.locator('[data-testid="eboot-disc-id"]')).not.toHaveValue('', { timeout: 5000 });
  await expect(page.locator('#artIcon0')).toHaveAttribute('src', /.+/, { timeout: 5000 });
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-multi-disc-loaded.png');

  // Verify auto-detected disc ID and title
  const discId = await page.locator('[data-testid="eboot-disc-id"]').inputValue();
  expect(discId).toBe('SLUS00001');

  const title = await page.locator('[data-testid="eboot-title"]').inputValue();
  expect(title.toLowerCase()).toContain('test game');

  // Verify disc list shows 2 discs
  const discList = page.locator('[data-testid="eboot-disc-list"]');
  await expect(discList.locator('.disc-item')).toHaveCount(2);
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-disc-list-2discs.png');

  // Verify build button is visible
  const buildBtn = page.locator('[data-testid="eboot-build-btn"]');
  await expect(buildBtn).toBeVisible();

  // Set workers to 1 for deterministic output
  await page.locator('#ebootThreads').fill('1');

  // Click build and capture download
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    buildBtn.click(),
  ]);

  // Wait for completion
  await expect(page.locator('[data-testid="eboot-status"]')).toContainText('Done', { timeout: 60000 });
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-multi-disc-build-done.png');

  // Verify download is a PBP named after the first disc file
  expect(download.suggestedFilename()).toBe('ps1-disc1.PBP');

  // Read the PBP and verify it starts with \0PBP magic
  const downloadPath = await download.path();
  const pbpBytes = new Uint8Array(fs.readFileSync(downloadPath));
  expect(pbpBytes[0]).toBe(0x00);
  expect(pbpBytes[1]).toBe(0x50); // P
  expect(pbpBytes[2]).toBe(0x42); // B
  expect(pbpBytes[3]).toBe(0x50); // P
});

test('Single disc with CUE+BIN → build EBOOT', async ({ page }) => {
  const disc1Bin = path.join(FIXTURES, 'ps1-disc1.bin');
  const disc1Cue = path.join(FIXTURES, 'ps1-disc1.cue');

  // Drop CUE and BIN together
  const input = page.locator('[data-testid="eboot-file-input"]');
  await input.setInputFiles([disc1Cue, disc1Bin]);

  // Wait for auto-detection and artwork to render
  await expect(page.locator('[data-testid="eboot-disc-id"]')).not.toHaveValue('', { timeout: 5000 });
  await expect(page.locator('#artIcon0')).toHaveAttribute('src', /.+/, { timeout: 5000 });
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-cue-bin-loaded.png');

  const discId = await page.locator('[data-testid="eboot-disc-id"]').inputValue();
  expect(discId).toBe('SLUS00001');

  // Build
  await page.locator('#ebootThreads').fill('1');
  const buildBtn = page.locator('[data-testid="eboot-build-btn"]');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    buildBtn.click(),
  ]);

  await expect(page.locator('[data-testid="eboot-status"]')).toContainText('Done', { timeout: 60000 });
  await waitForArtwork(page);
  await expect(page).toHaveScreenshot('eboot-cue-bin-build-done.png');

  expect(download.suggestedFilename()).toBe('ps1-disc1.PBP');
});
