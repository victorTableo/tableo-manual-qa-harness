import { mkdirSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { APP, roleFromLabel } from '../config/app.ts';
import { getLogin } from './accounts.ts';
import { getEnvironment } from './environments.ts';
import {
  CACHE_DIR,
  membershipCachePath,
  normalise,
  readDiscovery,
  type DiscoveryRecord,
  type Excluded,
  type Membership,
  type Restaurant,
} from './memberships.ts';
import { getLoginContext } from './auth.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { safeLog } from './report.ts';
import { activeRestaurant, openChooser } from './restaurants.ts';

/**
 * Discovers which restaurants the main login can act in, with which role and
 * plan, by reading the app. Read-only: it opens pages, never submits a form.
 *
 *   1. /admin/restaurants lists the restaurants (name + slug) in one page.
 *   2. Each restaurant's plan (Billing) and this login's role (Team Management)
 *      are read by slug, a few pages in parallel.
 *   3. Chooser entries missing from that list (e.g. where the login is not an
 *      admin, or a chain) are opened one by one to find their slug.
 *
 * Every restaurant is kept whatever its plan; only what cannot be read is
 * excluded, with the reason. The result is cached for lib/memberships.ts.
 */

const PARALLEL = 4;
const TIMEOUT = 20_000;

async function listedRestaurants(page: Page): Promise<Restaurant[]> {
  await page.goto(APP.restaurants.listPath, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  // Without an active restaurant the app redirects to the chooser: open the
  // first restaurant, then load the list again.
  if (new URL(page.url()).pathname !== APP.restaurants.listPath && (await openChooser(page)).length > 0) {
    await page.locator(APP.restaurants.chooserOption).first().click();
    await page.locator(APP.restaurants.active.selector).first().waitFor({ state: 'attached', timeout: TIMEOUT }).catch(() => undefined);
    await page.goto(APP.restaurants.listPath, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  }
  // The table is filled in by script after the page loads.
  await page
    .waitForFunction(
      (source) => [...document.querySelectorAll('table a[href]')].some((a) => new RegExp(source).test(a.getAttribute('href') ?? '')),
      APP.restaurants.slugInPath.source,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  return page.locator('table tbody tr, table tr').evaluateAll((rows, source) => {
    const slugPattern = new RegExp(source);
    const found = new Map<string, string>();
    for (const row of rows) {
      const slug = [...row.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href')?.match(slugPattern)?.[1])
        .find(Boolean);
      const cells = [...row.querySelectorAll('td')].map((td) => (td as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
      // "Name (City)" in the second column; the chooser and header show just "Name".
      const name = cells[1]?.replace(/\s*\([^()]*\)\s*$/, '');
      if (slug && name && !found.has(slug)) found.set(slug, name);
    }
    return [...found].map(([reference, name]) => ({ name, reference }));
  }, APP.restaurants.slugInPath.source);
}

/** Signed out mid-discovery: abort, so the last good cache is kept rather than overwritten. */
class SignedOutError extends Error {}

function signedOutCheck(page: Page): void {
  if (new URL(page.url()).pathname.startsWith(APP.login.path)) {
    throw new SignedOutError('Signed out during discovery; the cached restaurants were kept.');
  }
}

async function readPlan(page: Page, slug: string): Promise<{ plan: string } | string> {
  const response = await page.goto(APP.restaurants.planPath(slug), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  signedOutCheck(page);
  if ((response?.status() ?? 0) >= 400) {
    return `billing page returned HTTP ${response?.status()}`;
  }
  const filled = await page
    .waitForFunction((selector) => Boolean(document.querySelector(selector)?.textContent?.trim()), APP.restaurants.planName, { timeout: 10_000 })
    .then(() => true, () => false);
  const label = filled ? (await page.locator(APP.restaurants.planName).first().textContent())?.trim() : '';
  return label ? { plan: label } : `no plan shown (${APP.restaurants.planName} stayed empty)`;
}

async function readRole(page: Page, slug: string, username: string): Promise<{ label: string } | string> {
  const response = await page.goto(APP.restaurants.teamPath(slug), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  signedOutCheck(page);
  if ((response?.status() ?? 0) >= 400) {
    return `team page returned HTTP ${response?.status()}, so this login's role cannot be read`;
  }
  const label = await page.evaluate(
    ({ column, user }) => {
      for (const table of document.querySelectorAll('table')) {
        const headers = [...table.querySelectorAll('th')].map((th) => (th.textContent ?? '').trim().toLowerCase());
        const index = headers.indexOf(column.toLowerCase());
        if (index === -1) continue;
        // The exact address as a word: "devrms@x.com" must not match "qa.devrms@x.com".
        const row = [...table.querySelectorAll('tbody tr')].find((tr) =>
          ((tr as HTMLElement).innerText ?? '').toLowerCase().split(/\s+/).includes(user),
        );
        // innerText skips the hidden role description that textContent includes.
        return row ? ((row.querySelectorAll('td')[index] as HTMLElement | undefined)?.innerText ?? '').replace(/\s+/g, ' ').trim() : null;
      }
      return undefined;
    },
    { column: APP.restaurants.roleColumn, user: username.toLowerCase() },
  );
  if (label === undefined) return `no "${APP.restaurants.roleColumn}" column on the team page`;
  if (label === null) return 'this login is not listed on the team page';
  return label ? { label } : 'this login has an empty role';
}

async function inspect(context: BrowserContext, restaurant: Restaurant, username: string): Promise<Membership | Excluded> {
  const page = await context.newPage();
  try {
    const slug = restaurant.reference!;
    const plan = await readPlan(page, slug);
    if (typeof plan === 'string') return { restaurant: restaurant.name, reason: plan };
    const role = await readRole(page, slug, username);
    if (typeof role === 'string') return { restaurant: restaurant.name, reason: role };
    const mapped = roleFromLabel(role.label);
    if (!mapped) return { restaurant: restaurant.name, reason: `unknown role "${role.label}" (known: ${Object.keys(APP.restaurants.roleLabels).join(', ')})` };
    return { role: mapped, plan: plan.plan.toLowerCase(), restaurant };
  } catch (error) {
    if (error instanceof SignedOutError) throw error;
    return { restaurant: restaurant.name, reason: `could not be read: ${(error as Error).message.split('\n')[0]}` };
  } finally {
    await page.close();
  }
}

/** Reads every restaurant the main login can open, and caches the result. */
export async function discoverMemberships(browser: Browser, environment: string): Promise<DiscoveryRecord> {
  const env = getEnvironment(environment);
  const { username } = getLogin(env.name, 'main');
  // Discovery switches the session's restaurant, so it takes the environment's run lock too.
  acquireLock(env.name);
  const context = await getLoginContext(browser, env.name, 'main').catch((error) => {
    releaseLock(env.name);
    throw error;
  });
  const record: DiscoveryRecord = { environment: env.name, discoveredAt: new Date().toISOString(), memberships: [], excluded: [] };
  try {
    const page = await context.newPage();
    const restaurants = await listedRestaurants(page);

    // Chooser entries the list does not show: open each to learn its slug.
    const labels = await openChooser(page);
    for (const [index, label] of labels.entries()) {
      if (restaurants.some((r) => normalise(r.name) === normalise(label))) continue;
      try {
        await openChooser(page);
        const before = page.url();
        await page.locator(APP.restaurants.chooserOption).nth(index).click({ timeout: TIMEOUT });
        await page.waitForURL((url) => url.href !== before, { timeout: TIMEOUT }).catch(() => undefined);
        await page.locator(APP.restaurants.active.selector).first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined);
        const name = await activeRestaurant(page);
        const slug = new URL(page.url()).search.slice(1).split('&')[0] || page.url().match(APP.restaurants.slugInPath)?.[1];
        if (name && slug) restaurants.push({ name, reference: slug });
        else record.excluded.push({ restaurant: label, reason: 'not a single restaurant (no restaurant opened; a chain or group?)' });
      } catch (error) {
        record.excluded.push({ restaurant: label, reason: `could not be opened from the chooser: ${(error as Error).message.split('\n')[0]}` });
      }
    }
    if (new URL(page.url()).pathname.startsWith(APP.login.path) || (restaurants.length === 0 && record.excluded.length === 0)) {
      // Signed out or nothing readable: keep the last good cache rather than overwrite it with nothing.
      throw new Error(`Discovery found no restaurants (ended on ${new URL(page.url()).pathname}); the cached restaurants were kept.`);
    }
    await page.close();

    for (let i = 0; i < restaurants.length; i += PARALLEL) {
      const batch = await Promise.all(restaurants.slice(i, i + PARALLEL).map((r) => inspect(context, r, username)));
      for (const result of batch) {
        if ('role' in result) record.memberships.push(result);
        else record.excluded.push(result);
      }
    }
  } finally {
    await context.close();
    releaseLock(env.name);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(membershipCachePath(env.name), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

const refreshed = new Set<string>();

/**
 * Re-discovers at most once per process, unless discovery ran in the last two
 * minutes. Returns true when a fresh discovery ran. A failure is logged and the
 * caller reports BLOCKED as usual.
 */
export async function refreshOnce(browser: Browser, environment: string): Promise<boolean> {
  const name = getEnvironment(environment).name;
  if (refreshed.has(name)) return false;
  refreshed.add(name);
  const last = readDiscovery(name);
  if (last && Date.now() - Date.parse(last.discoveredAt) < 2 * 60_000) return false;
  try {
    await discoverMemberships(browser, name);
    return true;
  } catch (error) {
    safeLog(`Restaurant discovery for "${name}" failed: ${(error as Error).message}`);
    return false;
  }
}
