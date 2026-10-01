import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { AccountNotConfiguredError, getTestAccount } from '../lib/accounts.ts';
import { listEnvironmentNames, viewport } from '../lib/environments.ts';
import { membershipCachePath } from '../lib/memberships.ts';
import { getLoginContext, sessionPath } from '../lib/auth.ts';
import { createContext, getBrowser, SHARED_INFO, stopSharedBrowser } from '../lib/browser.ts';
import { assertionText, checklist, test as qaTest } from '../lib/checklist.ts';
import { crawl, pickCrawlRestaurants, SKIP } from '../lib/crawl.ts';
import { readSitemap, scrub, updateSitemapPage, writeSitemap } from '../lib/sitemap.ts';
import { acquireLock, releaseLock } from '../lib/lock.ts';
import { capture, saveDownload } from '../lib/evidence.ts';
import { discoverMemberships } from '../lib/discovery.ts';
import { recordNetwork } from '../lib/network.ts';
import { previousRun, redact, registerSecret, setTicket } from '../lib/report.ts';
import { activeRestaurant, pickOption, sameRestaurant } from '../lib/restaurants.ts';
import { currentCode, generateTotp, waitBeforeNextCode } from '../lib/totp.ts';
import { qaEmail, qaPhone, randomPhone, stripeCard } from '../config/test-data.ts';
import { decodeAll } from '../scripts/decode-ga-export.ts';

/**
 * HARNESS SELF-CHECK: proves the harness end to end against a loopback fixture
 * that mirrors Tableo's paths and markup (config/app.ts). Nothing real is touched.
 *   npm run selfcheck
 */

const PORT = 4599;
const PASSWORD = 'selfcheck-password';
const MAIN_USER = 'main@example.test';
const PROBE = 'PROBE-NEVER-SENT-001';
/** The only seed the fixture accepts; the super admin is given another one. */
const GOOD_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const OTHER_SEED = 'JBSWY3DPEHPK3PXP';

interface FixtureRestaurant { slug: string; name: string; city: string; plan: string; role: string; listed: boolean }
const RESTAURANTS: FixtureRestaurant[] = [
  { slug: 'grow-bistro', name: 'QA Grow Bistro', city: 'Valletta', plan: 'Grow', role: 'Manager', listed: true },
  { slug: 'gold-diner', name: 'QA Gold Diner', city: 'Mdina', plan: 'Gold', role: 'Administrator', listed: true },
  { slug: 'grill', name: 'QA Grill', city: 'Rabat', plan: 'Freemium', role: 'Read Only', listed: true },
  { slug: 'grill-house', name: 'QA Grill House', city: 'Rabat', plan: 'Freemium', role: 'Booker', listed: true },
  // Opens from the chooser but is not in /admin/restaurants (the login is not an admin there).
  { slug: 'hidden-cafe', name: 'QA Hidden Cafe', city: 'Gozo', plan: 'Organise', role: 'Booker', listed: false },
  // Two restaurants with the same display name: only the slug tells them apart.
  { slug: 'twin-a', name: 'QA Twin', city: 'Rabat', plan: 'Silver', role: 'Manager', listed: true },
  { slug: 'twin-b', name: 'QA Twin', city: 'Gozo', plan: 'Silver', role: 'Read Only', listed: true },
];
/** Chooser order: "Grill House" before "Grill" (substring trap), twin-a before twin-b (name trap). */
const CHOOSER = ['grill-house', 'grill', 'grow-bistro', 'gold-diner', 'hidden-cafe', 'twin-a', 'twin-b'];

let loginPosts = 0;
/** Server-side session token; changing it expires every saved session. */
let validSession = 'abc123';
/** When set, the restaurant list and chooser come back empty (a broken discovery). */
let emptyLists = false;
/** Requests to links a read-only crawl must never follow. */
let destructiveHits = 0;

const html = (body: string) => `<!doctype html><html><head><title>Tableo</title></head><body>${body}</body></html>`;
const header = (r?: FixtureRestaurant) =>
  r ? `<nav><span class="restaurant-name-text" title="${r.name}">${r.name.length > 10 ? `${r.name.slice(0, 9)}…` : r.name}</span></nav>` : '';

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const cookies = req.headers.cookie ?? '';
  const send = (body: string, headers: Record<string, string> = {}) => {
    res.writeHead(200, { 'content-type': 'text/html', ...headers });
    res.end(body);
  };
  const redirect = (location: string, cookie?: string) => {
    res.writeHead(302, { location, ...(cookie ? { 'set-cookie': cookie } : {}) });
    res.end();
  };
  const body = () => new Promise<URLSearchParams>((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(new URLSearchParams(raw)));
  });
  const active = RESTAURANTS.find((r) => cookies.includes(`active=${r.slug}`));

  if (url.pathname === '/login' && req.method === 'POST') {
    loginPosts += 1;
    return void body().then(() => redirect('/two-factor-challenge', 'pending=1; Path=/'));
  }
  if (url.pathname === '/login') {
    return send(html(`<form method="POST" action="/login"><input id="email" name="email"><input id="password" name="password" type="password"><button type="submit">Login</button></form>`));
  }
  if (url.pathname === '/two-factor-challenge' && req.method === 'POST') {
    return void body().then((form) =>
      form.get('code') === generateTotp(GOOD_SEED)
        ? redirect('/admin/dashboard', `session=${validSession}; Path=/`)
        : redirect('/two-factor-challenge?e=1'),
    );
  }
  if (url.pathname === '/two-factor-challenge') {
    if (!cookies.includes('pending=1')) return redirect('/login');
    return send(html(`<h1>Two-factor authentication</h1>
      <form method="POST" action="/two-factor-challenge"><input name="code">${url.searchParams.get('e') ? '<p class="invalid-feedback">The provided two factor authentication code was invalid.</p>' : ''}
        <label><input type="checkbox" name="remember_device"> Remember</label><button type="submit">Verify</button></form>
      <form method="POST" action="/two-factor-challenge" style="display:none"><input name="recovery_code"><button type="submit">Verify</button></form>
      <form method="POST" action="/two-factor-challenge/email"><button type="submit">Having trouble? Try another way</button></form>`));
  }
  if (url.pathname.startsWith('/admin') && !cookies.includes(`session=${validSession}`)) return redirect('/login');

  if (url.pathname === '/admin/unset-active-restaurant' || (url.pathname === '/admin/dashboard' && !active)) {
    const cards = (emptyLists ? [] : CHOOSER).map((slug) => RESTAURANTS.find((r) => r.slug === slug)!)
      .map((r) => `<div><b>${r.name}</b><button type="button" onclick="location.href='/admin/choose/${r.slug}'">Manage</button></div>`)
      .join('');
    // Mirrors Tableo: the button's text is "<name> Manage" through its card.
    return send(html(`<h1>Choose a restaurant</h1>${cards.replace(/<b>(.*?)<\/b><button([^>]*)>Manage/g, '<button$2>$1 Manage')}
      ${emptyLists ? '' : `<h2>Restaurant Chain</h2><div><button type="button" onclick="location.href='/admin/chain'">QA Chain Manage</button></div>`}`),
      { 'set-cookie': 'active=; Path=/' });
  }
  const choose = url.pathname.match(/^\/admin\/choose\/(.+)$/);
  if (choose) return redirect(`/admin/dashboard?${choose[1]}`, `active=${choose[1]}; Path=/`);
  if (url.pathname === '/admin/chain') return send(html('<h1>Chain overview</h1>'));
  if (url.pathname === '/admin/dashboard') {
    const s = active!.slug;
    const lock = active!.plan === 'Freemium' ? ' <i class="fa fa-lock"></i>' : '';
    return send(html(`${header(active)}<div id="sidebar"><a href="/admin/restaurants/${s}/bookings">Bookings</a>
      <a href="/admin/restaurants/${s}/reports/bookings-report">Booking Insights${lock}</a><a href="/admin/restaurants/${s}/services-hub/events">Events</a>
      <a href="/admin/restaurants/${s}/delete">Delete restaurant</a><a href="/logout">Logout</a><a href="https://example.org/help">Help</a></div>
      <h1>Dashboard</h1><p>Plan: ${active!.plan}</p>`));
  }
  if (url.pathname === '/logout' || /\/delete$/.test(url.pathname)) {
    destructiveHits += 1;
    return redirect('/admin/dashboard');
  }
  const widget = url.pathname.match(/^\/widget\/([^/]+)$/);
  if (widget && RESTAURANTS.some((r) => r.slug === widget[1])) {
    return send(html(`<h1>Book a table</h1><input id="no_of_adults" type="number"><button id="step1-next-btn" disabled>Next</button>`));
  }
  if (url.pathname === '/admin/restaurants') {
    const rows = RESTAURANTS.filter((r) => r.listed && !emptyLists)
      .map((r, i) => `<tr><td>#${i + 1}</td><td>${r.name} (${r.city})</td><td>Active</td><td><a href="/admin/restaurants/${r.slug}/edit">Edit</a></td></tr>`)
      .join('');
    return send(html(`${header(active)}<table><thead><tr><th>ID</th><th>Restaurant</th><th>Active</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`));
  }
  const page = url.pathname.match(/^\/admin\/restaurants\/([^/]+)\/(billing-subscription|managers)$/);
  const restaurant = page && RESTAURANTS.find((r) => r.slug === page[1]);
  if (restaurant && page[2] === 'billing-subscription') {
    // The plan name is rendered empty and filled in by script, like the real page.
    return send(html(`${header(restaurant)}<h5>Your current plan</h5><span id="current-plan-name"></span><span>Termination</span>
      <script>setTimeout(() => { document.getElementById('current-plan-name').textContent = '${restaurant.plan}'; }, 300);</script>`),
      { 'set-cookie': `active=${restaurant.slug}; Path=/` });
  }
  if (restaurant && page[2] === 'managers') {
    return send(html(`${header(restaurant)}<table><thead><tr><th>Name</th><th>Phone</th><th>Roles</th></tr></thead><tbody>
      <tr><td>Someone else<br>other@example.test</td><td>1</td><td>Administrator</td></tr>
      <tr><td>Decoy<br>qa.${MAIN_USER}</td><td>3</td><td>Booker</td></tr>
      <tr><td>Main<br>${MAIN_USER}</td><td>2</td><td>${restaurant.role} <span style="display:none">Full access to all areas</span></td></tr>
    </tbody></table>`));
  }
  const area = url.pathname.match(/^\/admin\/restaurants\/([^/]+)\/(bookings|reports\/bookings-report|services-hub\/events|edit)$/);
  const owner = area && RESTAURANTS.find((r) => r.slug === area[1]);
  if (owner && area[2] === 'bookings') {
    return send(html(`${header(owner)}<div class="content-wrapper"><h1>Bookings</h1><p>Bookings from today</p><input name="search" placeholder="Search">
      <table><thead><tr><th>Ref</th><th>Status</th></tr></thead><tbody><tr><td>AKJ-XG7</td><td><button id="status-dropdown-button-AKJ-XG7">Confirmed</button></td></tr></tbody></table></div>`));
  }
  if (owner && area[2] === 'reports/bookings-report') {
    if (owner.plan === 'Freemium') {
      res.writeHead(403, { 'content-type': 'text/html' });
      return res.end(html('<h1>Upgrade Required</h1>'));
    }
    return send(html(`${header(owner)}<h1>Booking Insights</h1>`));
  }
  if (owner && area[2] === 'services-hub/events') return send(html(`${header(owner)}<h1>Events</h1><button>Add event</button>`));
  if (owner && area[2] === 'edit') {
    return send(html(`${header(owner)}<h1>Account Settings</h1>
      <ul class="nav-tabs"><li><a href="#basic" data-bs-toggle="tab">Basic Data</a></li><li><a href="#booking-settings" data-bs-toggle="tab">Booking Settings</a></li></ul>
      <div id="basic"><label for="name">Name</label><input id="name" value="${owner.name}"></div>
      <div id="booking-settings" style="display:none"><label for="max_covers">Max covers</label><input id="max_covers" type="number"></div>
      <script>document.querySelectorAll('.nav-tabs a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault();
        document.querySelectorAll('#basic, #booking-settings').forEach((d) => { d.style.display = '#' + d.id === a.getAttribute('href') ? '' : 'none'; }); }));</script>`));
  }
  if (url.pathname === '/api/reports/restricted') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ allowed: false, leaked: PROBE, token: 'abcdefghijklmnop' }));
  }
  if (url.pathname === '/export.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export.csv"' });
    return res.end('id,status\n42,confirmed\n');
  }
  res.writeHead(404);
  res.end();
});

test.beforeAll(async () => {
  Object.assign(process.env, {
    QA_SELFCHECK_BASE_URL: `http://127.0.0.1:${PORT}`,
    QA_SELFCHECK_USERNAME: MAIN_USER,
    QA_SELFCHECK_PASSWORD: PASSWORD,
    QA_SELFCHECK_TOTP_SECRET: GOOD_SEED,
    QA_SELFCHECK_SUPER_ADMIN_USERNAME: 'root@example.test',
    QA_SELFCHECK_SUPER_ADMIN_PASSWORD: PASSWORD,
    QA_SELFCHECK_SUPER_ADMIN_TOTP_SECRET: OTHER_SEED,
    QA_PRODCHECK_BASE_URL: `http://127.0.0.1:${PORT}`,
    QA_PRODCHECK_PRODUCTION: '1',
    QA_PRODCHECK_SUPER_ADMIN_USERNAME: 'root@example.test',
    QA_PRODCHECK_SUPER_ADMIN_PASSWORD: PASSWORD,
  });
  for (const file of [sessionPath('selfcheck', 'main'), sessionPath('selfcheck', 'super_admin'), membershipCachePath('selfcheck')]) {
    rmSync(file, { force: true });
  }
  rmSync(path.resolve('artifacts/SELFCHECK-1'), { recursive: true, force: true });
  rmSync(path.resolve('artifacts/SELFCHECK-7'), { recursive: true, force: true });
  rmSync(path.resolve('artifacts/SELFCHECK-8'), { recursive: true, force: true });
  rmSync(path.resolve('artifacts/SELFCHECK-9'), { recursive: true, force: true });
  rmSync(path.resolve('artifacts/SELFCHECK-crawl'), { recursive: true, force: true });
  setTicket('SELFCHECK-1');
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('totp and Google Authenticator export decoding', () => {
  // RFC 6238 appendix B, SHA1, 6 digits.
  expect(generateTotp(GOOD_SEED, 59_000)).toBe('287082');
  expect(generateTotp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000)).toBe('287082');
  // Public export sample: raw secret bytes 19 00 30 90 85 EF 37 AD 6F 9D, not reversed.
  const decoded = decodeAll(['otpauth-migration://offline?data=CiQKChkAMJCF7zetb50SEmdpdGh1Yi5jb206YnJvb2tzdBoCbWUQARgBKAE%3D']);
  expect(decoded.problems).toEqual([]);
  expect(decoded.accounts[0]).toMatchObject({ secret: 'DEADBEEF54322345', issuer: 'me', name: 'github.com:brookst' });
});

test('failed assertions read as plain sentences', () => {
  expect(assertionText("expect(locator).toHaveCount(expected) failed\n\nLocator:  getByText('market-place.BI')\nExpected: 0\nReceived: 4\nTimeout:  10000ms"))
    .toBe('"market-place.BI" found 4 times (expected 0)');
  expect(assertionText('expect(locator).toBeVisible() failed\n\nLocator:  getByText(/Requires Grow/i).first()\nExpected: visible\nReceived: hidden'))
    .toBe('"Requires Grow" is not visible');
  expect(assertionText("expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Search' })\nExpected: visible\nError: element(s) not found"))
    .toBe('the "Search" button is not on the page');
  expect(assertionText('Search sits on the filter row\n\nexpect(received).toBe(expected)')).toBe('Search sits on the filter row');
  // Playwright already says "not" in Expected for .not matchers: it is said once.
  expect(assertionText("expect(locator).not.toHaveCount(expected) failed\n\nLocator: locator('span')\nExpected: not 0\nReceived: 0"))
    .toBe('span found 0 times (expected not 0)');
  expect(assertionText('expect(locator).not.toHaveText(expected) failed\n\nLocator: locator(\'h1\')\nExpected string: not "Bookings"\nReceived string: "Bookings"'))
    .toBe('h1 shows "Bookings" (expected not "Bookings")');
});

test('test data rules and overrides', () => {
  delete process.env.QA_EMAIL;
  delete process.env.QA_PHONE;
  expect(qaEmail()).toBe('glory+test@tableo.com');
  expect(qaEmail('guest')).toBe('glory+guest@tableo.com');
  expect(qaEmail('freemium')).toBe('glory+freemiumtest@tableo.com');
  expect(qaEmail(true)).toMatch(/^glory\+test[a-z0-9]+@tableo\.com$/);
  expect(qaPhone(1)).toBe('+35696968764');
  expect(randomPhone()).toMatch(/^\+3569696\d{4}$/);
  expect(stripeCard('decline').number).toBe('4000000000000002');
  expect(() => stripeCard('nope')).toThrow(/have: success, decline/);
  process.env.QA_PHONE = '+35699999999';
  process.env.QA_EMAIL = 'glory+promo-test@tableo.com';
  expect([qaPhone(1), randomPhone(), qaEmail('guest')]).toEqual(['+35699999999', '+35699999999', 'glory+promo-test@tableo.com']);
  process.env.QA_EMAIL = 'glory+promo@tableo.com';
  expect(() => qaEmail()).toThrow(/does not signal a test/);
  delete process.env.QA_EMAIL;
  delete process.env.QA_PHONE;
});

test('harness self-check', async ({ browser }) => {
  test.setTimeout(300_000);
  expect(listEnvironmentNames()).toEqual(expect.arrayContaining(['selfcheck', 'prodcheck']));

  // Before discovery, a restaurant role is BLOCKED and says so.
  expect(() => getTestAccount({ environment: 'selfcheck', role: 'manager', plan: 'grow' })).toThrow(/not been discovered yet/);

  // Discovery: list + parallel reads + chooser fallback, every plan kept, chain excluded.
  const record = await discoverMemberships(browser, 'selfcheck');
  expect(loginPosts).toBe(1);
  expect(record.memberships.map((m) => `${m.role}/${m.plan}@${m.restaurant.reference}`).sort()).toEqual([
    'booker/freemium@grill-house',
    'booker/organise@hidden-cafe',
    'manager/grow@grow-bistro',
    'manager/silver@twin-a',
    'readonly/freemium@grill',
    'readonly/silver@twin-b',
    'restaurant_admin/gold@gold-diner',
  ]);
  expect(record.excluded).toEqual([{ restaurant: 'QA Chain', reason: expect.stringContaining('not a single restaurant') }]);

  // A discovery that finds nothing keeps the last good cache (fix: never overwrite with nothing).
  const cached = readFileSync(membershipCachePath('selfcheck'), 'utf8');
  emptyLists = true;
  await expect(discoverMemberships(browser, 'selfcheck')).rejects.toThrow(/found no restaurants/);
  emptyLists = false;
  expect(readFileSync(membershipCachePath('selfcheck'), 'utf8')).toBe(cached);

  // Lookup: legacy plans usable, plan optional, restaurant pin, BLOCKED with an action.
  expect(getTestAccount({ environment: 'selfcheck', role: 'restaurant_admin', plan: 'Gold' }).restaurant?.name).toBe('QA Gold Diner');
  expect(getTestAccount({ environment: 'selfcheck', role: 'booker', restaurant: 'hidden-cafe' }).plan).toBe('organise');
  let missing: AccountNotConfiguredError | undefined;
  try {
    getTestAccount({ environment: 'selfcheck', role: 'manager', plan: 'expand' });
  } catch (error) {
    missing = error as AccountNotConfiguredError;
  }
  expect(missing).toBeInstanceOf(AccountNotConfiguredError);
  expect(missing!.action).toContain('"Manager" role in a restaurant on the "Expand" plan');
  expect(missing!.message).toContain('Manager @ QA Grow Bistro (Grow)');
  expect(missing!.message).not.toContain(MAIN_USER);
  // Prose-like values are not masked (that would point at them); tokens, emails, seeds are.
  registerSecret('Business');
  registerSecret('s3cret-pass!');
  expect(redact('Basic Business Reports, s3cret-pass!')).toBe('Basic Business Reports, ***');
  expect(redact('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toContain('Basic ***');

  // Restaurant names match exactly, never by substring.
  expect(sameRestaurant('QA Grill House', 'QA Grill')).toBe(false);
  expect(sameRestaurant("TBL - Anast…", "TBL - Anastasiia's Resto")).toBe(true);
  expect(pickOption(['QA Grill House', 'QA Grill'], 'QA Grill')).toBe(1);
  expect(sameRestaurant('Ресторан Глория', 'ресторан глория')).toBe(true);
  expect(sameRestaurant('Café A', 'Cafè A')).toBe(false);

  // A ticket run: every outcome, one report, evidence under the ticket.
  const undone: string[] = [];
  const run = checklist(browser, 'SELFCHECK-1', { environment: 'selfcheck', title: 'harness self-check', source: '1. ...\n2. ...' });
  await run.check('manager sees the Grow dashboard', { role: 'manager', plan: 'grow' }, async ({ page, note, change }) => {
    await expect(page.locator('body')).toContainText('Plan: Grow');
    note(`dashboard of ${await activeRestaurant(page)}`);
    change('Pretend setting switched on', async () => { undone.push('setting'); });
    change('Pretend booking created');
  });
  await run.check('readonly lands in QA Grill, not QA Grill House', { role: 'readonly' }, async ({ page }) => {
    expect(await activeRestaurant(page)).toBe('QA Grill');
  });
  await run.check('deliberately failing assertion', { role: 'manager', plan: 'grow' }, async ({ page, note }) => {
    note('dashboard opened');
    await expect(page.locator('body')).toContainText('Text that is not there', { timeout: 1_000 });
  });
  await run.check('manager on an Expand restaurant', { role: 'manager', plan: 'expand' }, async () => {});
  await run.check('broken automation step', { role: 'manager', plan: 'grow' }, async ({ page }) => {
    await page.locator('#does-not-exist').click({ timeout: 1_000 });
  });
  await run.check('super admin with a wrong seed', { role: 'super_admin' }, async () => {});
  await run.check('super admin again: a rejected login is not retried', { role: 'super_admin' }, async () => {});
  await run.check('read only lands in the right "QA Twin" by slug', { role: 'readonly', plan: 'silver' }, async ({ page, note }) => {
    expect(page.url()).toContain('twin-b');
    note(`header "${await activeRestaurant(page)}", URL ${new URL(page.url()).search}`);
  });
  await run.check('assertion on a missing element is an automation error', { role: 'manager', plan: 'grow' }, async ({ page }) => {
    await expect(page.locator('#no-such-element')).toBeVisible({ timeout: 1_000 });
  });
  await run.check('same, with the selector verified, is an app failure', { role: 'manager', plan: 'grow' }, async ({ page }) => {
    await expect(page.locator('#no-such-element')).toBeVisible({ timeout: 1_000 });
  }, { selectorVerified: true });
  await run.check('protected environment is blocked, not an error', { role: 'super_admin', environment: 'prodcheck' }, async () => {});
  run.manual('confirmation email arrives', 'needs a real inbox');
  await run.check('Gold admin sees the Gold plan', { role: 'restaurant_admin', plan: 'gold' }, async ({ page }) => {
    await expect(page.locator('body')).toContainText('Plan: Gold');
  }, { extra: { why: 'legacy plans are usable too' } });
  run.noticed('A raw translation key on the fixture page');
  process.env.QA_CHANGELOG = 'artifacts/SELFCHECK-1/CHANGELOG.md';
  run.learned('Gold restaurants show "Plan: Gold" on the dashboard', 'knowledge/app.md');
  const reportFile = await run.finish();

  const status = Object.fromEntries(run.results.map((r) => [r.title, r.status]));
  expect(status).toEqual({
    'manager sees the Grow dashboard': 'PASS',
    'readonly lands in QA Grill, not QA Grill House': 'PASS',
    'deliberately failing assertion': 'FAIL',
    'manager on an Expand restaurant': 'BLOCKED',
    'broken automation step': 'ERROR',
    'super admin with a wrong seed': 'BLOCKED',
    'super admin again: a rejected login is not retried': 'BLOCKED',
    'read only lands in the right "QA Twin" by slug': 'PASS',
    'assertion on a missing element is an automation error': 'ERROR',
    'same, with the selector verified, is an app failure': 'FAIL',
    'protected environment is blocked, not an error': 'BLOCKED',
    'confirmation email arrives': 'BLOCKED',
    'Gold admin sees the Gold plan': 'PASS',
  });
  expect(run.results.find((r) => r.title.startsWith('protected'))!.reason).toContain('QA_ALLOW_PRODUCTION=1');
  expect(loginPosts).toBe(2); // main login reused from discovery; the super admin's bad login tried once only
  expect(undone).toEqual(['setting']);
  const report = readFileSync(reportFile, 'utf8');
  expect(report).toContain('**Result:** ✅ 3 passed · ❌ 2 failed · ⛔ 5 not tested · ⚠️ 2 errors');
  expect(report).toContain('### ❌ Failed (2)');
  // Expected vs actual in plain words, no matcher dump; a first run never compares with earlier runs.
  // A note from an earlier step never hides what failed.
  expect(report).toContain('- Actual: dashboard opened. the page shows');
  expect(report).toContain('(expected "Text that is not there")');
  expect(report).toContain('- Actual: #no-such-element is not on the page');
  expect(report).not.toContain('expect(locator)');
  expect(report).not.toContain('Changes since the previous run');
  expect(report).toContain('### ⛔ Not tested (5)');
  expect(report).not.toContain('No action given');
  expect(report).toContain('**To do:**');
  expect(report).toContain('The provided two factor authentication code was invalid.');
  expect(report).toContain('### 💡 Also checked (not in the ticket)');
  expect(report).toContain('👀 Noticed: A raw translation key');
  // The Linear report carries results only; changes and lessons stay in the repo.
  expect(report).not.toContain('Pretend setting');
  expect(report).not.toContain('Plan: Gold" on the dashboard');
  const notes = readFileSync(path.join(path.dirname(reportFile), 'run-notes.md'), 'utf8');
  expect(notes).toContain('Pretend setting switched on (QA Grow Bistro) — reverted ✔');
  expect(notes).toContain('Pretend booking created (QA Grow Bistro) — left in place');
  expect(notes).toContain('→ `knowledge/app.md`');
  // Lessons are about the app, never the ticket: the knowledge stays reusable.
  const changelog = readFileSync('artifacts/SELFCHECK-1/CHANGELOG.md', 'utf8');
  expect(changelog).toMatch(/- \d{4}-\d{2}-\d{2}: Gold restaurants show/);
  expect(changelog).not.toContain('SELFCHECK-1');
  delete process.env.QA_CHANGELOG;
  for (const secret of [PASSWORD, GOOD_SEED, OTHER_SEED, MAIN_USER]) {
    expect(report).not.toContain(secret);
  }
  const runFolder = path.relative(process.cwd(), path.dirname(reportFile));
  expect(runFolder).toMatch(/^artifacts\/SELFCHECK-1\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(AM|PM)$/);
  const firstShot = run.results[0]!.evidence[0]!;
  expect(firstShot).toMatch(/screenshots\/\d{2}-manager-sees-the-grow-dashboard\.png$/);
  // Framed: the browser bar sits above the 1080px viewport (PNG height is at byte 20).
  expect(readFileSync(firstShot).readUInt32BE(20)).toBeGreaterThan(viewport().height);

  // A retest re-runs only what did not pass, carries passes over, and says what changed.
  const retest = checklist(browser, 'SELFCHECK-1', { environment: 'selfcheck', retest: 'failed' });
  let reran = 0;
  await retest.check('manager sees the Grow dashboard', { role: 'manager', plan: 'grow' }, async () => { reran += 1; });
  await retest.check('deliberately failing assertion', { role: 'manager', plan: 'grow' }, async ({ page }) => {
    await expect(page.locator('body')).toContainText('Plan: Grow');
  });
  const retestFile = await retest.finish();
  expect(reran).toBe(0);
  expect(retest.results.map((r) => r.status)).toEqual(['PASS', 'PASS']);
  expect(path.basename(path.dirname(retestFile))).toMatch(/_retest$/);
  const retestReport = readFileSync(retestFile, 'utf8');
  expect(retestReport).toContain('### 🔁 Changes since the previous run');
  expect(retestReport).toContain('❌ → ✅ deliberately failing assertion');
  expect(retestReport).toContain('not re-run');
  expect(retestReport).toContain('## QA: SELFCHECK-1 — harness self-check');
  expect(retestReport).toMatch(/`\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(AM|PM)\/01-manager-sees-the-grow-dashboard\.png`/);

  // Retests only look at earlier runs of the same environment.
  expect(previousRun('SELFCHECK-1', 'selfcheck')).not.toBeNull();
  expect(previousRun('SELFCHECK-1', 'prodcheck')).toBeNull();

  // An environment that is not configured: every check BLOCKED naming the variable; the run still reports.
  const unset = checklist(browser, 'SELFCHECK-8', { environment: 'nosuchenv' });
  await unset.check('anything', { role: 'restaurant_admin' }, async () => {});
  await unset.finish();
  expect(unset.results[0]).toMatchObject({ status: 'BLOCKED', reason: expect.stringContaining('QA_NOSUCHENV_BASE_URL') });

  // The app ends a trusted session: the next check lands on /login, signs in again once, and passes.
  // A mobile check reuses the session (no sign-in) at the phone's size, and the report says so.
  const rerun = checklist(browser, 'SELFCHECK-9', { environment: 'selfcheck' });
  await rerun.check('before the app ends the session', { role: 'manager', plan: 'grow' }, async () => {});
  validSession = 'ended-by-app';
  const postsBefore = loginPosts;
  await rerun.check('after the app ended the session', { role: 'manager', plan: 'grow' }, async ({ page }) => {
    await expect(page.locator('body')).toContainText('Plan: Grow');
  });
  expect(loginPosts).toBe(postsBefore + 1);
  await rerun.check('dashboard on a phone', { role: 'manager', plan: 'grow', device: 'mobile' }, async ({ page }) => {
    expect(page.viewportSize()?.width).toBe(390);
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    await expect(page.locator('body')).toContainText('Plan: Grow');
  });
  expect(loginPosts).toBe(postsBefore + 1);
  const rerunReport = readFileSync(await rerun.finish(), 'utf8');
  expect(rerun.results.map((r) => r.status)).toEqual(['PASS', 'PASS', 'PASS']);
  expect(rerunReport).toContain('- dashboard on a phone · Mobile (390×664)');
  expect(rerunReport).not.toMatch(/after the app ended the session · (Mobile|Desktop)/);
  expect(rerun.results[2]!.evidence[0]).toMatch(/dashboard-on-a-phone-mobile\.png$/);

  // Crawl: read-only, plan-aware, records only pages (never rows or values), compared with the pricing table.
  expect(pickCrawlRestaurants(record.memberships).map((m) => m.restaurant.reference)).toEqual(['gold-diner']);
  expect(SKIP.test('/admin/restaurants/x/bookings/cancel/ABC')).toBe(true);
  expect(scrub('Bookings from October 1, 2025 to Thursday, October 1 2026')).toBe('Bookings from <date> to <date>');
  expect(scrub('Glory tester Bookings · Glory-Testing · QA Glory')).toBe('<guest> Bookings · <guest> · QA <guest>');
  const crawlDir = path.resolve('artifacts/SELFCHECK-crawl');
  const plansFile = path.join(crawlDir, 'plans.md');
  rmSync(crawlDir, { recursive: true, force: true });
  (await import('node:fs')).mkdirSync(crawlDir, { recursive: true });
  writeFileSync(plansFile, [
    '| Feature | Freemium | Organise | Grow | Expand | Admin path (to confirm) |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Event Management | ✗ | ✗ | ✓ | ✓ | `services-hub/events` |',
    '| Basic Business Reports | ✗ | ✓ | ✓ | ✓ | `reports/bookings-report` |',
  ].join('\n'));
  const gold = record.memberships.find((m) => m.restaurant.reference === 'gold-diner')!;
  const grill = record.memberships.find((m) => m.restaurant.reference === 'grill')!;
  const site = await crawl(browser, 'selfcheck', { restaurants: [gold, grill], plansFile });
  expect(destructiveHits).toBe(0);
  const reports = site.pages['/admin/restaurants/<slug>/reports/bookings-report']!;
  expect(reports.access).toEqual({ Gold: 'open', Freemium: '403 (Upgrade Required) 🔒' });
  expect(reports.h1).toBe('Booking Insights');
  expect(site.structureFrom).toBe('Gold');
  const bookings = site.pages['/admin/restaurants/<slug>/bookings']!;
  expect(bookings.controls).toContain('`input[name="search"]` input[text] "Search"');
  expect(bookings.tables).toEqual([['Ref', 'Status']]);
  expect(JSON.stringify(bookings)).not.toContain('AKJ-XG7');
  const settings = site.pages['/admin/restaurants/<slug>/edit']!;
  expect(settings.access.Gold).toBe('open (not in sidebar)');
  expect(settings.tabs.find((t) => t.label === 'Booking Settings')?.controls).toEqual(['`#max_covers` input[number] "Max covers"']);
  expect(JSON.stringify(settings)).not.toContain('QA Gold Diner');
  expect(site.pages['/widget/<slug>']!.access).toEqual({ Gold: 'open', Freemium: 'open' });
  expect(site.differs).toEqual([expect.stringContaining('Event Management (`/admin/restaurants/<slug>/services-hub/events`): pricing excludes it on Freemium')]);
  expect(site.gaps[0]).toContain('Organise, Grow, Expand');
  const sitemapFile = writeSitemap(site, crawlDir);
  const sitemap = readFileSync(sitemapFile, 'utf8');
  expect(sitemap).toContain('## Bookings — `/admin/restaurants/<slug>/bookings`');
  expect(sitemap.slice(sitemap.indexOf('\n## '))).not.toMatch(/gold-diner|QA Gold Diner|QA Grill/);
  // Probe write-back replaces one page's structure and keeps the other plans' access.
  updateSitemapPage({ path: '/admin/restaurants/<slug>/bookings', h1: 'Bookings', under: '', headings: [], tables: [], controls: ['`#new` button "New"'] }, 'selfcheck', { label: 'Silver', access: 'open' }, crawlDir);
  const updated = readSitemap(crawlDir)!.pages['/admin/restaurants/<slug>/bookings']!;
  expect(updated.access).toEqual({ Gold: 'open', Freemium: 'open', Silver: 'open' });
  expect(updated.controls).toEqual(['`#new` button "New"']);

  // A saved session the app has expired is noticed and replaced by a fresh sign-in
  // (QA_SESSION_RECHECK_MINUTES=0: always check, as a session proven minutes ago is otherwise trusted).
  process.env.QA_SESSION_RECHECK_MINUTES = '0';
  validSession = 'rotated';
  const before = loginPosts;
  const renewed = await getLoginContext(browser, 'selfcheck');
  const renewedPage = await renewed.newPage();
  await renewedPage.goto('/admin/dashboard');
  expect(new URL(renewedPage.url()).pathname).toBe('/admin/dashboard');
  expect(loginPosts).toBe(before + 1);
  await renewed.close();
  delete process.env.QA_SESSION_RECHECK_MINUTES;

  // A 2FA code is never issued twice in one 30-second window (apps reject reuse).
  const spareSeed = 'MFRGGZDFMZTWQ2LK';
  await currentCode(spareSeed);
  expect(waitBeforeNextCode(spareSeed)).toBeGreaterThan(0);

  // One run per environment: a live lock elsewhere blocks, a run's own lock is re-entrant.
  writeFileSync('.auth/locktest.lock', JSON.stringify({ pid: process.ppid, since: 'earlier' }));
  expect(() => acquireLock('locktest')).toThrow(/another QA run is using "locktest"/);
  writeFileSync('.auth/locktest.lock', '{"pid": 12'); // half-written by a crashed run: taken over
  acquireLock('locktest');
  releaseLock('locktest');
  acquireLock('locktest');
  acquireLock('locktest');
  releaseLock('locktest');
  expect(existsSync('.auth/locktest.lock')).toBe(true);
  releaseLock('locktest');
  expect(existsSync('.auth/locktest.lock')).toBe(false);

  // Network capture waits for bodies, and the dump is redacted.
  const context = await createContext(browser, { environment: 'selfcheck' });
  const netPage = await context.newPage();
  const net = recordNetwork(netPage, { urlPattern: '/api/reports', captureBodies: true });
  await netPage.goto('/api/reports/restricted');
  expect(net.find({ status: 200 }).length).toBe(1);
  expect(await net.bodiesContaining([PROBE])).toEqual([PROBE]);
  const dump = readFileSync(await net.save('restricted'), 'utf8');
  expect(dump).not.toContain('abcdefghijklmnop');

  // Screenshot settings: without the frame the image is exactly the 1080px-high viewport.
  process.env.QA_SCREENSHOT_FRAME = '0';
  expect(readFileSync(await capture(netPage, 'unframed')).readUInt32BE(20)).toBe(viewport().height);
  delete process.env.QA_SCREENSHOT_FRAME;
  expect(readFileSync(await capture(netPage, 'framed')).readUInt32BE(20)).toBeGreaterThan(viewport().height);

  const [download] = await Promise.all([netPage.waitForEvent('download'), netPage.goto('/export.csv').catch(() => undefined)]);
  const saved = await saveDownload(download, 'export');
  expect(readFileSync(saved, 'utf8')).toContain('confirmed');
  await context.close();

  await expect(createContext(browser, { environment: 'prodcheck' })).rejects.toThrow(/QA_ALLOW_PRODUCTION=1/);
});

// The checklist fixture finishes a run even when the spec crashes: undo runs, report is written.
qaTest.fail('a crashing spec still finishes its run', async ({ checklist }) => {
  const run = checklist('SELFCHECK-7', { environment: 'selfcheck' });
  await run.check('records a change', { role: 'manager', plan: 'grow' }, async ({ change }) => {
    change('Marker setting switched on', async () => {
      writeFileSync('artifacts/SELFCHECK-7/undo-ran', 'yes');
    });
  });
  throw new Error('the spec crashed after its first check');
});

test('the crashed run was undone and reported', () => {
  expect(existsSync('artifacts/SELFCHECK-7/undo-ran')).toBe(true);
  expect(previousRun('SELFCHECK-7', 'selfcheck')?.results.map((r) => r.status)).toEqual(['PASS']);
});

// Every command shares one browser: a second connection reuses the running one.
test('the shared browser is reused, then stopped', async () => {
  const first = await getBrowser();
  const info = readFileSync(SHARED_INFO, 'utf8');
  const second = await getBrowser();
  expect(readFileSync(SHARED_INFO, 'utf8')).toBe(info);
  expect(first.isConnected() && second.isConnected()).toBe(true);
  await first.close();
  expect(second.isConnected()).toBe(true);
  await second.close();
  expect(stopSharedBrowser()).toBe(true);
  expect(existsSync(SHARED_INFO)).toBe(false);
});
