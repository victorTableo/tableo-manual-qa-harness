import type { Locator, Page } from '@playwright/test';
import { stripeCard } from '../config/test-data.ts';
import { getEnvironment } from './environments.ts';

/**
 * Small, verified building blocks for actions tickets often need. Whole flows
 * (booking via the diary or widget, changing settings, plan changes) are
 * step-by-step recipes in knowledge/playbooks.md.
 */

const base = (slug: string) => `/admin/restaurants/${encodeURIComponent(slug)}`;

/** Phone inputs use an international widget: type key by key so it picks the country from "+356…". */
export async function fillPhone(input: Locator, number: string): Promise<void> {
  await input.click();
  await input.fill('');
  await input.pressSequentially(number, { delay: 30 });
  await input.blur();
}

/** Reference (e.g. "AKJ-XG7") of the newest booking in the list for this guest name, or null. */
export async function newestBookingRef(page: Page, slug: string, guest: string): Promise<string | null> {
  await page.goto(`${base(slug)}/bookings`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('tbody tr').filter({ hasText: guest }).first();
  await row.waitFor({ timeout: 15_000 }).catch(() => undefined);
  const href = await row.locator('a[href*="/bookings/show/"]').first().getAttribute('href').catch(() => null);
  return href?.split('/bookings/show/')[1]?.split(/[?#]/)[0] ?? null;
}

/**
 * Cancels a confirmed booking, or rejects a pending one (widget bookings arrive
 * pending). Returns the status the booking page shows afterwards.
 */
export async function cancelBooking(page: Page, slug: string, ref: string): Promise<string> {
  const url = `${base(slug)}/bookings/show/${encodeURIComponent(ref)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true }).first();
  const reject = page.getByRole('button', { name: 'Reject', exact: true }).first();
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  else if (await reject.isVisible().catch(() => false)) await reject.click();
  else throw new Error(`Booking ${ref} offers neither Cancel nor Reject.`);
  await page.getByRole('button', { name: "Yes I'm sure!" }).click();
  await page.waitForLoadState('domcontentloaded');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return (await page.locator('body').innerText()).match(/\b(CANCELLED|REJECTED|CONFIRMED|PENDING)\b/)?.[0] ?? 'unknown';
}

/** The Marketplace toggle of an add-on, found by its card title (e.g. "Email Branding"). */
async function addonToggle(page: Page, slug: string, name: string): Promise<Locator> {
  await page.goto(`${base(slug)}/restaurant-addons`, { waitUntil: 'domcontentloaded' });
  await page.locator('.content-wrapper input[type=checkbox]').first().waitFor({ state: 'attached' });
  // The card is the largest ancestor that still holds only this one toggle; its title is a line of
  // its text. Match the whole line, so "Reports" never picks "Basic Business Reports".
  const toggles = page.locator('.content-wrapper input[type=checkbox]');
  const { index, titles } = await toggles.evaluateAll((boxes, wanted) => {
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    const lines = boxes.map((box) => {
      let card: HTMLElement = box as HTMLElement;
      while (card.parentElement && card.parentElement.querySelectorAll('input[type=checkbox]').length === 1) card = card.parentElement;
      return (card.innerText ?? '').split('\n').map(norm).filter(Boolean);
    });
    return { index: lines.findIndex((l) => l.includes(norm(wanted))), titles: lines.map((l) => l.slice(0, 3).join(' / ')) };
  }, name);
  if (index === -1) throw new Error(`No Marketplace add-on titled "${name}". Cards: ${titles.join('; ')}`);
  return toggles.nth(index);
}

/**
 * Switches a Marketplace add-on on or off. Returns the previous state, so the
 * caller can undo: `ctx.change('Email Branding on', (p) => setAddon(p, slug, 'Email Branding', was))`.
 * Paid add-ons are purchases: only switch one on when the ticket needs it and the
 * QA engineer approved it for this run.
 */
export async function setAddon(page: Page, slug: string, name: string, on: boolean): Promise<boolean> {
  const toggle = await addonToggle(page, slug, name);
  const was = await toggle.isChecked();
  if (was === on) return was;
  if (await toggle.isDisabled()) throw new Error(`The "${name}" toggle is disabled for this restaurant.`);
  // The input is visually replaced by a styled switch, so click it directly.
  await toggle.click({ force: true });
  const modal = page.locator('.modal.show, .swal2-popup').first();
  await modal.waitFor({ timeout: 10_000 }).catch(() => undefined);
  // Switching off asks "Are you sure… Disable"; switching on shows "Added to your profile".
  const disable = modal.getByRole('button', { name: 'Disable', exact: true });
  if (!on && (await disable.isVisible().catch(() => false))) await disable.click();
  await page.waitForTimeout(1_000);
  const after = await (await addonToggle(page, slug, name)).isChecked();
  if (after !== on) throw new Error(`"${name}" is still ${after ? 'on' : 'off'} after switching.`);
  return was;
}

/**
 * Fills a Stripe card form with one of the test cards in config/test-data.json
 * ("success", "decline", ...). Refuses unless the environment is not
 * production-protected and the page uses a Stripe test key (pk_test_), so a real
 * charge is impossible.
 */
export async function fillStripeCard(page: Page, environment: string, kind = 'success'): Promise<void> {
  const card = stripeCard(kind);
  if (getEnvironment(environment).productionProtected) {
    throw new Error(`Refusing to enter a card on protected environment "${environment}".`);
  }
  const html = await page.content();
  if (/pk_live_/.test(html) || !/pk_test_/.test(html)) {
    throw new Error('Refusing to enter a card: this page does not use a Stripe test key (pk_test_).');
  }
  // One combined card element, or split elements (number / expiry / CVC each in its own frame).
  const field = async (selector: string) => {
    for (const frame of page.frames()) {
      if (!frame.url().includes('js.stripe.com')) continue;
      const input = frame.locator(selector).first();
      if (await input.count().catch(() => 0)) return input;
    }
    return undefined;
  };
  const fill = async (selector: string, value: string, required = true) => {
    const input = await field(selector);
    if (!input) { if (required) throw new Error(`Stripe card field not found: ${selector}`); return; }
    await input.fill(value);
  };
  await fill('input[name="cardnumber"], input[name="number"]', card.number);
  await fill('input[name="exp-date"], input[name="expiry"]', card.expiry);
  await fill('input[name="cvc"]', card.cvc);
  await fill('input[name="postal"], input[name="postalCode"]', card.postcode, false);
}
