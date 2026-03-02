import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 500,
    },
  },
  projects: [
    { name: 'chromium', use: {
      browserName: 'chromium',
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      launchOptions: {
        args: [
          '--font-render-hinting=none',
          '--disable-font-subpixel-positioning',
          '--disable-lcd-text',
          '--force-device-scale-factor=1',
        ],
      },
    } },
    { name: 'firefox', use: {
      browserName: 'firefox',
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    } },
  ],
});
