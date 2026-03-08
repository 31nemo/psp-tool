import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_HTML = path.join(ROOT, 'dist', 'index.html');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function fileUrl(p) {
  return 'file://' + p;
}

test.beforeEach(async ({ page }) => {
  await page.goto(fileUrl(DIST_HTML));
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  // Switch to Diagnose tab
  await page.locator('.tab-btn[data-tab="diagnose"]').click();
});

async function loadDiagnoseFile(page, filePath) {
  await page.locator('[data-testid="diagnose-file-input"]').setInputFiles(filePath);
}

// ── Raw disc image (ps1-disc1.bin has raw sync pattern) ──────────────────────

test('inspect disc image: shows disc info with sector size', async ({ page }) => {
  await loadDiagnoseFile(page, path.join(FIXTURES, 'ps1-disc1.bin'));
  await expect(page.locator('#diagnoseStatus')).toContainText('Inspection complete');
  // Should show DISC format badge
  await expect(page.locator('#diagnoseFileMeta')).toContainText('DISC');
  // Raw sectors are 2352 bytes
  await expect(page.locator('#diagnoseResults')).toContainText('2352');
  await expect(page.locator('#diagnoseResults')).toContainText('Disc Info');
});

// ── Disc ID and title detection ──────────────────────────────────────────────

test('inspect raw BIN: detects disc ID and title', async ({ page }) => {
  await loadDiagnoseFile(page, path.join(FIXTURES, 'ps1-disc1.bin'));
  await expect(page.locator('#diagnoseStatus')).toContainText('Inspection complete');
  // The mock PS1 disc has SYSTEM.CNF with disc ID
  await expect(page.locator('#diagnoseResults')).toContainText('Disc ID');
});

// ── CUE file ────────────────────────────────────────────────────────────────

test('inspect CUE file: shows track listing', async ({ page }) => {
  await loadDiagnoseFile(page, path.join(FIXTURES, 'ps1-disc1.cue'));
  await expect(page.locator('#diagnoseStatus')).toContainText('Inspection complete');
  await expect(page.locator('#diagnoseFileMeta')).toContainText('CUE');
  await expect(page.locator('#diagnoseResults')).toContainText('1 track');
  await expect(page.locator('#diagnoseResults')).toContainText('ps1-disc1.bin');
  await expect(page.locator('#diagnoseResults')).toContainText('MODE2/2352');
});

// ── IPS patch ───────────────────────────────────────────────────────────────

test('inspect IPS patch: shows records, data size, and patched range', async ({ page }) => {
  await loadDiagnoseFile(page, path.join(FIXTURES, 'patch-test.ips'));
  await expect(page.locator('#diagnoseStatus')).toContainText('Inspection complete');
  await expect(page.locator('#diagnoseFileMeta')).toContainText('IPS');
  await expect(page.locator('#diagnoseResults')).toContainText('Records');
  await expect(page.locator('#diagnoseResults')).toContainText('Total data written');
  await expect(page.locator('#diagnoseResults')).toContainText('Patched range');
});

// ── PPF patch ───────────────────────────────────────────────────────────────

test('inspect PPF patch: shows version, block check, and record count', async ({ page }) => {
  await loadDiagnoseFile(page, path.join(FIXTURES, 'patch-test-blockcheck.ppf'));
  await expect(page.locator('#diagnoseStatus')).toContainText('Inspection complete');
  await expect(page.locator('#diagnoseFileMeta')).toContainText('PPF');
  await expect(page.locator('#diagnoseResults')).toContainText('Version');
  await expect(page.locator('#diagnoseResults')).toContainText('Block check');
  await expect(page.locator('#diagnoseResults')).toContainText('Records');
});

// ── xdelta/VCDIFF patch ─────────────────────────────────────────────────────

test('inspect xdelta patch: shows windows and output size', async ({ page }) => {
  await loadDiagnoseFile(page, path.join(FIXTURES, 'patch-test.xdelta'));
  await expect(page.locator('#diagnoseStatus')).toContainText('Inspection complete');
  await expect(page.locator('#diagnoseFileMeta')).toContainText('VCDIFF');
  await expect(page.locator('#diagnoseResults')).toContainText('Windows');
  await expect(page.locator('#diagnoseResults')).toContainText('Total output');
  await expect(page.locator('#diagnoseResults')).toContainText('Secondary compression');
});

test('inspect multi-window LZMA xdelta: shows window count and compression', async ({ page }) => {
  await loadDiagnoseFile(page, path.join(FIXTURES, 'vcdiff-multi-lzma.xdelta'));
  await expect(page.locator('#diagnoseStatus')).toContainText('Inspection complete');
  await expect(page.locator('#diagnoseResults')).toContainText('LZMA');
  await expect(page.locator('#diagnoseResults')).toContainText('Windows');
  await expect(page.locator('#diagnoseResults')).toContainText('Window sizes');
});

// ── Unknown file ────────────────────────────────────────────────────────────

test('inspect unknown file: shows hex dump', async ({ page }) => {
  // test.iso is sequential bytes with no recognized format magic
  await loadDiagnoseFile(page, path.join(FIXTURES, 'test.iso'));
  await expect(page.locator('#diagnoseStatus')).toContainText('Inspection complete');
  await expect(page.locator('#diagnoseFileMeta')).toContainText('???');
  await expect(page.locator('#diagnoseResults')).toContainText('Hex Dump');
});

// ── CSO file (generated from test.iso via convert tab) ──────────────────────

test('inspect CSO file: shows header and compression info', async ({ page }) => {
  // First generate a CSO via the convert tab
  await page.locator('.tab-btn[data-tab="convert"]').click();
  await page.locator('[data-testid="convert-file-input"]').setInputFiles(path.join(FIXTURES, 'test.iso'));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="convert-to-cso"]').click(),
  ]);
  const downloadPath = await download.path();
  const csoPath = path.join(FIXTURES, 'tmp-diagnose-test.cso');
  fs.copyFileSync(downloadPath, csoPath);

  // Switch to diagnose tab and inspect the CSO
  await page.locator('.tab-btn[data-tab="diagnose"]').click();
  await loadDiagnoseFile(page, csoPath);
  await expect(page.locator('#diagnoseStatus')).toContainText('Inspection complete');
  await expect(page.locator('#diagnoseFileMeta')).toContainText('CSO');
  await expect(page.locator('#diagnoseResults')).toContainText('CSO Header');
  await expect(page.locator('#diagnoseResults')).toContainText('Block count');
  await expect(page.locator('#diagnoseResults')).toContainText('Compression ratio');

  // Clean up
  fs.unlinkSync(csoPath);
});
