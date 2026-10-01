import { getEnvironment } from '../lib/environments.ts';
import { getBrowser } from '../lib/browser.ts';
import { crawl, pickCrawlRestaurants } from '../lib/crawl.ts';
import { listMemberships } from '../lib/memberships.ts';
import { relativeToRoot } from '../lib/report.ts';
import { writeSitemap } from '../lib/sitemap.ts';

/**
 * Maps Tableo into knowledge/sitemap.md: every admin page, what is on it, and what
 * each plan sees. Read-only (lib/crawl.ts). Re-run when the app changed or the
 * sitemap is older than a month (~1 min per plan).
 *   npm run crawl -- --env=victor                      one Administrator restaurant per plan
 *   npm run crawl -- --env=victor --restaurant=<slug>  (repeatable) choose them
 */

const args = process.argv.slice(2);
const env = getEnvironment(args.find((a) => a.startsWith('--env='))?.slice(6) ?? process.env.QA_ENV ?? '');
const slugs = args.filter((a) => a.startsWith('--restaurant=')).map((a) => a.slice(13));
const all = listMemberships(env.name);
const restaurants = slugs.length
  ? slugs.map((slug) => {
      const hit = all.find((m) => m.restaurant.reference === slug && m.role === 'restaurant_admin');
      if (!hit) throw new Error(`"${slug}" is not a restaurant where the main login is Administrator (npm run memberships -- --env=${env.name}).`);
      return hit;
    })
  : pickCrawlRestaurants(all);

const browser = await getBrowser();
try {
  const started = Date.now();
  const map = await crawl(browser, env.name, { restaurants });
  const file = writeSitemap(map);
  console.log(`\n${Object.keys(map.pages).length} pages, ${map.sources.join('; ')} in ${Math.round((Date.now() - started) / 1000)}s → ${relativeToRoot(file)}`);
  if (map.gaps.length) console.log(`Not crawled: ${map.gaps.join('; ')}`);
  if (map.differs.length) console.log(`Differs from the pricing page: ${map.differs.length} (listed at the top of the sitemap)`);
} finally {
  await browser.close();
}
