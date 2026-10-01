import { defineConfig } from '@playwright/test';
import { getEnvironment, slowMo, viewport, watching } from './lib/environments.ts';

/**
 * Evidence (screenshots, network dumps, downloads, report.md) is written by the
 * helpers into artifacts/<TICKET>/<run>/. Playwright's own output (traces,
 * failure context, results.json) goes to artifacts/.playwright/, overwritten
 * each run. baseURL comes from QA_ENV when set; checklist() and the helpers
 * create their own contexts with the right environment either way.
 */

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFlag(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

const selected = (process.env.QA_ENV ?? '').trim();
// QA_WATCH=1 shows the browser, each action slowed (QA_SLOWMO) so the clicks can be followed.
const headed = watching();

export default defineConfig({
  testDir: './tests',
  outputDir: 'artifacts/.playwright/test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: envInt('QA_RETRIES', 0),
  workers: 1,
  timeout: envInt('QA_TIMEOUT_MS', 90_000),
  expect: { timeout: envInt('QA_EXPECT_TIMEOUT_MS', 10_000) },
  reporter: [['list'], ['json', { outputFile: 'artifacts/.playwright/results.json' }]],
  use: {
    ...(selected ? { baseURL: getEnvironment(selected).baseUrl } : {}),
    headless: !headed,
    launchOptions: { slowMo: slowMo() },
    actionTimeout: envInt('QA_ACTION_TIMEOUT_MS', 15_000),
    navigationTimeout: envInt('QA_NAVIGATION_TIMEOUT_MS', 30_000),
    viewport: viewport(),
    locale: process.env.QA_LOCALE ?? 'en-GB',
    timezoneId: process.env.QA_TIMEZONE ?? 'Europe/London',
    acceptDownloads: true,
    // Off by default: a trace keeps DOM snapshots with typed values, including a
    // one-time code on the MFA form. QA_TRACE=1 when you need one.
    trace: envFlag('QA_TRACE') ? 'on' : 'off',
    screenshot: 'off',
    video: 'off',
  },
});
