import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page, Response } from '@playwright/test';
import { APP, planLabel } from '../config/app.ts';
import { getEnvironment } from './environments.ts';
import { getLoginContext } from './auth.ts';
import { createContext } from './browser.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { listMemberships, type Membership } from './memberships.ts';
import { mapPage, type PageMap } from './pagemap.ts';
import { selectRestaurant } from './restaurants.ts';
import { safeLog } from './report.ts';
import { controlLine, generalise, KNOWLEDGE_DIR, structureOf, today, type Sitemap, type SitemapPage } from './sitemap.ts';

/**
 * Read-only crawl of the admin, one Administrator restaurant per plan: every
 * sidebar page (plus Account Settings and the public widget), its structure
 * from the restaurant that sees the most, and what each plan sees there.
 * GET only: it follows links and clicks in-page tabs, never a form or an
 * action button, and never a link that reads like an action (SKIP).
 */

/** Links never followed: they act rather than show. */
export const SKIP = /delete|destroy|remove|cancel|reject|log-?out|sign-?out|export|download|unset|switch-plan|impersonat|\/store\b|\/update\b|\.csv|\.pdf|\.xlsx/i;

/** Pages worth mapping that the sidebar may not link. */
const EXTRA_PATHS = ['/admin/restaurants/<slug>/edit'];

interface Visit {
  access: string;
  map?: PageMap;
  tabs?: SitemapPage['tabs'];
}

interface SidebarLink {
  path: string;
  label: string;
  locked: boolean;
}

/** One Administrator restaurant per plan, in memberships order. */
export function pickCrawlRestaurants(memberships: Membership[]): Membership[] {
  const byPlan = new Map<string, Membership>();
  for (const m of memberships) if (m.role === 'restaurant_admin' && !byPlan.has(m.plan)) byPlan.set(m.plan, m);
  return [...byPlan.values()];
}

function realPath(template: string, slug: string): string {
  return template.split('<slug>').join(slug);
}

async function sidebar(page: Page, baseUrl: string, m: Membership): Promise<SidebarLink[]> {
  const links = await page.locator('#sidebar a[href]').evaluateAll((anchors) =>
    anchors.map((a) => ({
      href: (a as HTMLAnchorElement).href,
      label: ((a as HTMLElement).innerText || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
      locked: Boolean(a.querySelector('[class*="lock"]')) || /🔒/.test((a as HTMLElement).innerText),
    })),
  );
  const origin = new URL(baseUrl).origin;
  const out: SidebarLink[] = [];
  for (const link of links) {
    const url = new URL(link.href, baseUrl);
    if (url.origin !== origin || !url.pathname.startsWith('/admin') || SKIP.test(url.pathname) || !link.label) continue;
    const template = generalise(url.pathname, m.restaurant);
    if (!out.some((o) => o.path === template)) out.push({ path: template, label: generalise(link.label, m.restaurant), locked: link.locked });
  }
  return out;
}

function accessOf(response: Response | null, map: PageMap | undefined, wanted: string, landed: string): string {
  const status = response?.status() ?? 0;
  if (status >= 400) return `${status}${map?.wall ? ` (${map.wall})` : ''}`;
  if (map?.wall) return `wall: ${map.wall}`;
  // A page that opens one of its own sub-pages (tables → tables/manage) is open.
  if (landed !== wanted && !landed.startsWith(`${wanted}/`)) return `redirect → ${landed}`;
  return 'open';
}

class SignedOut extends Error {}

/** Opens one page and maps it, tab panes included. */
async function visit(page: Page, url: string, template: string, m: Membership): Promise<Visit> {
  let response: Response | null = null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (error) {
    return { access: `error: ${(error as Error).message.split('\n')[0]!.slice(0, 80)}` };
  }
  const landedUrl = new URL(page.url());
  if (landedUrl.pathname.startsWith(APP.login.path)) throw new SignedOut('Signed out during the crawl.');
  // Many pages fill in by script after load.
  await page.waitForTimeout(1000);
  const map = await mapPage(page, { all: true });
  const landed = generalise(landedUrl.pathname, m.restaurant);
  const access = accessOf(response, map, template, landed);
  const tabs: SitemapPage['tabs'] = [];
  if (access === 'open') {
    for (const tab of map.tabs.filter((t) => t.target.startsWith('#') && t.target.length > 1).slice(0, 15)) {
      try {
        await page.locator(`[href="${tab.target}"], [data-bs-target="${tab.target}"]`).first().click({ timeout: 3_000 });
        await page.waitForTimeout(300);
        if (new URL(page.url()).pathname !== landedUrl.pathname) break; // a "tab" that navigates: stop
        const pane = await mapPage(page, { all: true, scope: tab.target });
        tabs.push({ label: generalise(tab.label, m.restaurant), controls: pane.controls.filter((c) => !c.inTable).map((c) => generalise(controlLine(c), m.restaurant)) });
      } catch {
        tabs.push({ label: generalise(tab.label, m.restaurant), controls: [] });
      }
    }
  }
  return { access, map, tabs };
}

/** "Event Management" | ✗ ✗ ✓ ✓ | `services-hub/events` rows of knowledge/plans.md. */
export function readEntitlements(file = path.join(KNOWLEDGE_DIR, 'plans.md')): Array<{ feature: string; plans: Record<string, boolean>; paths: string[] }> {
  if (!existsSync(file)) return [];
  const rows = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().startsWith('|')).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const header = rows.find((r) => r.some((c) => /^freemium$/i.test(c)));
  if (!header) return [];
  const planColumns = header.flatMap((c, i) => ((APP.currentPlans as readonly string[]).includes(c.toLowerCase()) ? [[i, c.toLowerCase()] as const] : []));
  const pathColumn = header.findIndex((c) => /path/i.test(c));
  return rows
    .filter((r) => r !== header && !/^-+$/.test(r[0]?.replace(/:/g, '') ?? '') && pathColumn !== -1)
    .map((r) => ({
      feature: r[0]!.replace(/\*/g, ''),
      plans: Object.fromEntries(planColumns.map(([i, plan]) => [plan, !/^(✗|—|-|no)?$/i.test(r[i] ?? '')])),
      paths: [...(r[pathColumn] ?? '').matchAll(/`([^`]+)`/g)].map((p) => (p[1]!.startsWith('/') ? p[1]! : `/admin/restaurants/<slug>/${p[1]}`)),
    }))
    .filter((e) => e.paths.length);
}

function differences(pages: Record<string, SitemapPage>, crawledPlans: string[], plansFile?: string): string[] {
  const out: string[] = [];
  for (const e of readEntitlements(plansFile)) {
    for (const plan of crawledPlans.filter((p) => p in e.plans)) {
      for (const p of e.paths) {
        const state = pages[p]?.access[planLabel(plan)];
        if (!state) continue;
        const open = state === 'open';
        if (e.plans[plan] && !open) out.push(`${e.feature} (\`${p}\`): pricing includes it on ${planLabel(plan)}, the app shows "${state}"`);
        if (!e.plans[plan] && open) out.push(`${e.feature} (\`${p}\`): pricing excludes it on ${planLabel(plan)}, the page is open`);
      }
    }
  }
  return out;
}

export interface CrawlOptions {
  /** Default: one Administrator restaurant per plan (pickCrawlRestaurants). */
  restaurants?: Membership[];
  /** knowledge/plans.md by default. */
  plansFile?: string;
}

export async function crawl(browser: Browser, environment: string, options: CrawlOptions = {}): Promise<Sitemap> {
  const env = getEnvironment(environment);
  const chosen = options.restaurants ?? pickCrawlRestaurants(listMemberships(env.name));
  if (!chosen.length) throw new Error(`No Administrator restaurant known on "${env.name}": run npm run memberships -- --env=${env.name} first.`);
  acquireLock(env.name);
  let context: BrowserContext | undefined;
  let signedOut: BrowserContext | undefined;
  try {
    context = await getLoginContext(browser, env.name, 'main');
    signedOut = await createContext(browser, { environment: env.name });
    const page = await context.newPage();

    // 1. Each restaurant's sidebar.
    const sidebars = new Map<Membership, SidebarLink[]>();
    for (const m of chosen) {
      await selectRestaurant(page, m.restaurant);
      sidebars.set(m, await sidebar(page, env.baseUrl, m));
      safeLog(`${planLabel(m.plan)}: ${sidebars.get(m)!.length} sidebar links`);
    }
    const templates = new Map<string, string>();
    for (const links of sidebars.values()) for (const l of links) if (!templates.has(l.path)) templates.set(l.path, l.label);
    for (const extra of EXTRA_PATHS) if (!templates.has(extra)) templates.set(extra, 'Account Settings');

    // 2. Every page as every restaurant.
    const visits = new Map<string, Map<Membership, Visit>>();
    for (const m of chosen) {
      await selectRestaurant(page, m.restaurant);
      for (const template of templates.keys()) {
        const v = await visit(page, realPath(template, m.restaurant.reference!), template, m);
        const link = sidebars.get(m)!.find((l) => l.path === template);
        v.access += link ? (link.locked ? ' 🔒' : '') : ' (not in sidebar)';
        if (!visits.has(template)) visits.set(template, new Map());
        visits.get(template)!.set(m, v);
      }
      // The public widget, signed out.
      const widget = await signedOut.newPage();
      const template = '/widget/<slug>';
      if (!visits.has(template)) visits.set(template, new Map());
      visits.get(template)!.set(m, await visit(widget, realPath(template, m.restaurant.reference!), template, m).catch((e) => ({ access: `error: ${(e as Error).message.slice(0, 80)}` })));
      templates.set(template, 'Public widget');
      await widget.close();
      safeLog(`${planLabel(m.plan)}: ${templates.size} pages visited`);
    }

    // 3. Structure from the restaurant that sees the most; each plan's access.
    const openCount = (m: Membership) => [...visits.values()].filter((v) => v.get(m)?.access.startsWith('open')).length;
    const structure = [...chosen].sort((a, b) => openCount(b) - openCount(a))[0]!;
    const pages: Record<string, SitemapPage> = {};
    for (const [template, byRestaurant] of visits) {
      const source = byRestaurant.get(structure)?.map && byRestaurant.get(structure)!.access.startsWith('open')
        ? structure
        : chosen.find((m) => byRestaurant.get(m)?.access.startsWith('open')) ?? structure;
      const v = byRestaurant.get(source);
      const addons: Record<string, string[]> = {};
      for (const m of chosen) {
        const states = byRestaurant.get(m)?.map?.addons ?? [];
        if (states.length) addons[planLabel(m.plan)] = states.map((a) => generalise(`${a.name}: ${a.state}`, m.restaurant));
      }
      pages[template] = {
        path: template,
        area: templates.get(template) ?? template,
        checked: today(),
        ...(v?.map ? structureOf(v.map, source.restaurant) : { h1: '', under: '', headings: [], tables: [], controls: [] }),
        tabs: v?.tabs ?? [],
        access: Object.fromEntries(chosen.map((m) => [planLabel(m.plan), (byRestaurant.get(m)?.access ?? 'not visited').trim()])),
        ...(Object.keys(addons).length ? { addons } : {}),
      };
    }
    const crawledPlans = chosen.map((m) => m.plan);
    const missing = (APP.currentPlans as readonly string[]).filter((p) => !crawledPlans.includes(p));
    return {
      environment: env.name,
      crawledAt: new Date().toISOString(),
      sources: chosen.map((m) => `${planLabel(m.plan)} (${m.restaurant.name})`),
      structureFrom: planLabel(structure.plan),
      gaps: missing.length ? [`${missing.map(planLabel).join(', ')} (the login is Administrator in no restaurant on ${missing.length > 1 ? 'these plans' : 'this plan'})`] : [],
      differs: differences(pages, crawledPlans, options.plansFile),
      pages,
    };
  } catch (error) {
    if (error instanceof SignedOut) throw new Error('The session was signed out during the crawl; nothing was written. Re-run npm run crawl.');
    throw error;
  } finally {
    await signedOut?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    releaseLock(env.name);
  }
}
