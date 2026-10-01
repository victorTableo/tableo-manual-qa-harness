import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Download, Page } from '@playwright/test';
import { artifactPath, nextIndex, relativeToRoot } from './report.ts';

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'item';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** What a screenshot is for; decides full page vs viewport (QA_SCREENSHOT_FULL_PAGE). */
export type ShotKind = 'pass' | 'failure' | 'step';

/**
 * Screenshot settings from .env (defaults in brackets):
 *   QA_SCREENSHOT_FRAME      1 | 0                       [1]        browser bar with URL and time
 *   QA_SCREENSHOT_FULL_PAGE  always | failures | never  [failures] whole scrollable page
 *   QA_SCREENSHOT_ON_PASS    1 | 0                       [1]        screenshot when a check passes
 */
export function screenshotSettings(): { frame: boolean; fullPage: 'always' | 'failures' | 'never'; onPass: boolean } {
  const off = (name: string) => ['0', 'false', 'no', 'off'].includes((process.env[name] ?? '').trim().toLowerCase());
  const mode = (process.env.QA_SCREENSHOT_FULL_PAGE ?? '').trim().toLowerCase();
  return {
    frame: !off('QA_SCREENSHOT_FRAME'),
    fullPage: mode === 'always' || mode === 'never' ? mode : 'failures',
    onPass: !off('QA_SCREENSHOT_ON_PASS'),
  };
}

/**
 * Screenshot of the page, password fields masked. By default it is framed like a
 * browser window whose address bar shows the URL and local time, so every image
 * says where and when it was taken; the frame is drawn in a scratch page, never on
 * the page under test. Returns the repo-relative path.
 */
export async function capture(page: Page, name: string, kind: ShotKind = 'step'): Promise<string> {
  const settings = screenshotSettings();
  const fullPage = settings.fullPage === 'always' || (settings.fullPage === 'failures' && kind === 'failure');
  const target = artifactPath('screenshots', `${String(nextIndex('screenshots')).padStart(2, '0')}-${slug(name)}.png`);
  const shot = await page.screenshot({ fullPage, mask: [page.locator('input[type="password"]')], maskColor: '#000' });
  if (!settings.frame) {
    writeFileSync(target, shot);
    return relativeToRoot(target);
  }
  const width = page.viewportSize()?.width ?? 1920;
  const url = page.url();
  const time = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).replace(/\b(am|pm)\b/, (m) => m.toUpperCase());
  const frame = await page.context().newPage();
  try {
    await frame.setViewportSize({ width, height: 400 });
    await frame.setContent(`<!doctype html><html><body style="margin:0;background:#dee1e6">
      <div id="window" style="width:${width}px;font:13px system-ui,sans-serif">
        <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:#dee1e6">
          <span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span>
          <span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span>
          <span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span>
          <div style="flex:1;margin-left:8px;padding:6px 12px;border-radius:16px;background:#fff;color:#202124;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(url)}</div>
          <span style="color:#3c4043">${escapeHtml(time)}</span>
        </div>
        <img style="display:block;width:${width}px" src="data:image/png;base64,${shot.toString('base64')}">
      </div></body></html>`);
    await frame.locator('img').evaluate((img: HTMLImageElement) => img.decode());
    await frame.locator('#window').screenshot({ path: target });
  } finally {
    await frame.close();
  }
  return relativeToRoot(target);
}

/** Saves a download, keeping its extension. Returns the repo-relative path. */
export async function saveDownload(download: Download, name?: string): Promise<string> {
  const failure = await download.failure();
  if (failure) {
    throw new Error(`Download failed: ${failure}`);
  }
  const suggested = download.suggestedFilename();
  const base = name ? `${slug(name)}${path.extname(suggested)}` : suggested;
  const target = artifactPath('downloads', `${String(nextIndex('downloads')).padStart(2, '0')}-${base}`);
  await download.saveAs(target);
  return relativeToRoot(target);
}

/** Runs a click (or anything) that triggers a download, and saves it. */
export async function captureDownload(page: Page, trigger: () => Promise<unknown>, name?: string): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return saveDownload(download, name);
}
