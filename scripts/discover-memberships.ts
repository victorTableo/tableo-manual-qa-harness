import { getEnvironment } from '../lib/environments.ts';
import { coverageReport } from '../lib/memberships.ts';
import { getBrowser } from '../lib/browser.ts';
import { discoverMemberships } from '../lib/discovery.ts';

/**
 * Reads which restaurants the main login can act in (role + plan each) and
 * prints coverage. Read-only against the app. Runs by itself once a day when a
 * check needs a restaurant; run it by hand after granting a role.
 *   npm run memberships -- --env=devrms
 */

const named = process.argv.slice(2).find((arg) => arg.startsWith('--env='))?.slice(6);
const env = getEnvironment(named ?? process.env.QA_ENV ?? '');
const browser = await getBrowser();
try {
  const started = Date.now();
  await discoverMemberships(browser, env.name);
  console.log(`Environment ${env.name}: discovered in ${Math.round((Date.now() - started) / 1000)}s\n`);
  console.log(coverageReport(env.name).join('\n'));
} finally {
  await browser.close();
}
