import { DEVICES, getEnvironment, type Device } from '../lib/environments.ts';
import { createContext, getBrowser } from '../lib/browser.ts';
import { forgetSessionCheck, getLoginContext } from '../lib/auth.ts';
import { selectRestaurant } from '../lib/restaurants.ts';
import { readDiscovery } from '../lib/memberships.ts';
import { capture } from '../lib/evidence.ts';
import { relativeToRoot, setTicket } from '../lib/report.ts';
import { acquireLock, releaseLock } from '../lib/lock.ts';
import { formatPageMap, mapPage } from '../lib/pagemap.ts';
import { generalise, readSitemap, structureOf, updateSitemapPage } from '../lib/sitemap.ts';
import { APP, planLabel } from '../config/app.ts';

/**
 * Look at pages before writing checks: one sign-in and one restaurant switch for
 * any number of paths. Prints a compact map per page (headings, text under the
 * H1, tabs, tables, visible controls with a selector hint and their row), saves
 * one framed screenshot each, and updates that page in knowledge/sitemap.md.
 *
 *   npm run probe -- --env=devrms --restaurant=ben-prelaunch-rest /admin/restaurants/ben-prelaunch-rest/bookings [more paths]
 *   options: --width=1440   --device=tablet|tablet-landscape|mobile   --all (controls below the fold too)
 *            --super-admin   --signed-out   --no-save
 * Only an Administrator's desktop view of a page is written to the sitemap (the crawl's view).
 */

const args = process.argv.slice(2);
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const flag = (name: string) => args.includes(`--${name}`);
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) {
  console.error('Usage: npm run probe -- --env=<env> [--restaurant=<slug>] [--width=1920] <path> [<path>...]');
  process.exit(1);
}
const env = getEnvironment(option('env') ?? process.env.QA_ENV ?? '');
const width = Number(option('width') ?? 0);
const device = (option('device') ?? 'desktop') as Device;
if (!DEVICES.includes(device)) {
  console.error(`--device must be one of: ${DEVICES.join(', ')}`);
  process.exit(1);
}
const kind = flag('super-admin') ? 'super_admin' : 'main';

// The probe switches the session's restaurant, so it takes the environment's run lock like a run does.
acquireLock(env.name);
const browser = await getBrowser();
try {
  const context = flag('signed-out')
    ? await createContext(browser, { environment: env.name, device })
    : await getLoginContext(browser, env.name, kind, device);
  const page = await context.newPage();
  if (width) await page.setViewportSize({ width, height: page.viewportSize()?.height ?? 1080 });
  const slug = option('restaurant');
  const membership = slug ? readDiscovery(env.name)?.memberships.find((m) => m.restaurant.reference === slug) : undefined;
  const restaurant = membership?.restaurant ?? (slug ? { name: slug, reference: slug } : undefined);
  if (restaurant) await selectRestaurant(page, restaurant);
  setTicket('probe');
  const sitemapEnv = readSitemap()?.environment;
  const writeBack =
    !flag('no-save') && !flag('signed-out') && !flag('super-admin') && !width && device === 'desktop' &&
    membership?.role === 'restaurant_admin' && (!sitemapEnv || sitemapEnv === env.name);
  for (const target of targets) {
    const response = await page.goto(target, { waitUntil: 'domcontentloaded' });
    const onLogin = new URL(page.url()).pathname.startsWith(APP.login.path);
    if (onLogin && !flag('signed-out')) forgetSessionCheck(env.name, kind); // signed out: the next command signs in again
    await page.waitForTimeout(1500);
    const map = await mapPage(page, { all: flag('all') });
    console.log(`\n${response?.status()} ${page.url()}  [${page.viewportSize()?.width}px] "${map.title}"`);
    for (const line of formatPageMap(map)) console.log(line);
    console.log(`Screenshot: ${await capture(page, `probe ${target}`)}`);
    // Pages (not searches or one record) go to the sitemap, so they need no probe next time.
    const status = response?.status() ?? 0;
    if (writeBack && !onLogin && status < 400 && !new URL(page.url()).search.replace(`?${slug ?? ''}`, '')) {
      const pathTemplate = generalise(new URL(page.url()).pathname, restaurant);
      const access = map.wall ? `wall: ${map.wall}` : 'open';
      const full = flag('all') ? map : await mapPage(page, { all: true });
      const file = updateSitemapPage({ path: pathTemplate, ...structureOf(full, restaurant) }, env.name, { label: planLabel(membership!.plan), access });
      console.log(`Sitemap: ${pathTemplate} → ${relativeToRoot(file)}`);
    }
  }
  await context.close();
} finally {
  await browser.close();
  releaseLock(env.name);
}
