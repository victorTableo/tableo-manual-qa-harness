import type { Page } from '@playwright/test';
import { APP } from '../config/app.ts';
import { AccountNotConfiguredError } from './accounts.ts';
import type { Restaurant } from './memberships.ts';

/**
 * Restaurant switching with proof. A check scoped to a restaurant only runs once
 * the header reads back exactly that restaurant; otherwise it is BLOCKED, because
 * a result about the wrong restaurant is worse than no result.
 */

export class RestaurantNotConfirmedError extends AccountNotConfiguredError {
  readonly observed: string | null;
  constructor(message: string, observed: string | null, action?: string) {
    super(message, action);
    this.name = 'RestaurantNotConfirmedError';
    this.observed = observed;
  }
}

/** Case, spacing and punctuation ignored; letters of any script and accents kept. */
function normalise(value: string): string {
  return value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '');
}

/**
 * Exact match after normalising case, spacing and punctuation: "Grill" must never
 * confirm "Grill House". A header that visibly truncates ("TBL - Anast…") may
 * match by prefix, if long enough to be meaningful.
 */
export function sameRestaurant(observed: string, expected: string): boolean {
  const truncated = /(\.\.\.|…)\s*$/.test(observed.trim());
  const seen = normalise(observed.replace(/(\.\.\.|…)\s*$/, ''));
  const wanted = normalise(expected);
  return Boolean(wanted) && (seen === wanted || (truncated && seen.length >= 8 && wanted.startsWith(seen)));
}

/** The restaurant the header shows, or null on a page without one. */
export async function activeRestaurant(page: Page): Promise<string | null> {
  const element = page.locator(APP.restaurants.active.selector).first();
  if (!(await element.count())) {
    return null;
  }
  const value = (await element.getAttribute(APP.restaurants.active.attribute)) || (await element.innerText());
  return value?.trim() || null;
}

/**
 * Opens the restaurant chooser and returns its labels (minus "Manage"). Right
 * after a restaurant was opened the app sometimes renders the chooser without
 * options, so it is loaded once more before giving up.
 */
export async function openChooser(page: Page): Promise<string[]> {
  const options = page.locator(APP.restaurants.chooserOption);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(APP.restaurants.chooserPath, { waitUntil: 'domcontentloaded' });
    if (await options.first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
      break;
    }
  }
  return (await options.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim().replace(APP.restaurants.chooserLabelSuffix, ''));
}

/** Index of the chooser option for a name: exact label, else the shortest label starting with it. */
export function pickOption(labels: string[], name: string): number {
  const wanted = normalise(name);
  let best = -1;
  for (const [index, label] of labels.entries()) {
    const seen = normalise(label);
    if (seen === wanted) return index;
    if (seen.startsWith(`${wanted} `) && (best === -1 || seen.length < normalise(labels[best]!).length)) best = index;
  }
  return best;
}

/**
 * True when the page shows this restaurant: the header name matches and, when the
 * slug is known, the sidebar links carry it (two restaurants can share a name).
 */
export async function isActive(page: Page, restaurant: Restaurant): Promise<boolean> {
  const shown = await activeRestaurant(page);
  if (!shown || !sameRestaurant(shown, restaurant.name)) return false;
  if (!restaurant.reference) return true;
  const query = new URL(page.url()).search.slice(1).split('&')[0];
  return query === restaurant.reference || (await page.locator(APP.restaurants.slugLink(restaurant.reference)).count()) > 0;
}

const NOT_CONFIRMED_ACTION =
  'Check that the restaurant still exists and this login can open it; if it was renamed, run npm run memberships, then re-run.';

/**
 * Makes the restaurant the session's active one through the chooser (the only way
 * that reliably sets it for pages without a slug in the URL), unless it already is,
 * and confirms it by name and slug. Same-named options are tried in turn until the
 * slug matches.
 */
export async function selectRestaurant(page: Page, restaurant: Restaurant, timeout = 20_000): Promise<string> {
  if (!page.url().startsWith('http')) {
    await page.goto('/admin/dashboard', { waitUntil: 'domcontentloaded' });
  }
  if (await isActive(page, restaurant)) {
    return (await activeRestaurant(page))!;
  }
  const labels = await openChooser(page);
  const exact = labels.flatMap((label, index) => (normalise(label) === normalise(restaurant.name) ? [index] : []));
  const candidates = exact.length ? exact : [pickOption(labels, restaurant.name)].filter((index) => index !== -1);
  if (!candidates.length) {
    throw new RestaurantNotConfirmedError(
      `BLOCKED: "${restaurant.name}" is not in the restaurant chooser (it offers: ${JSON.stringify(labels)}).`,
      null,
      NOT_CONFIRMED_ACTION,
    );
  }
  let observed: string | null = null;
  for (const [attempt, index] of candidates.entries()) {
    if (attempt > 0) await openChooser(page);
    await page.locator(APP.restaurants.chooserOption).nth(index).click();
    await page.waitForURL((url) => url.pathname !== APP.restaurants.chooserPath, { timeout }).catch(() => undefined);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await isActive(page, restaurant)) return (await activeRestaurant(page))!;
      observed = await activeRestaurant(page);
      // A header is shown and it is not ours (other name, or same name with another slug): next option.
      if (observed) break;
      await page.waitForTimeout(300);
    }
  }
  throw new RestaurantNotConfirmedError(
    `BLOCKED: could not confirm "${restaurant.name}"${restaurant.reference ? ` [${restaurant.reference}]` : ''}; the app shows "${observed ?? 'no restaurant'}". ` +
      'A requirement is never reported against an unconfirmed restaurant.',
    observed,
    NOT_CONFIRMED_ACTION,
  );
}
