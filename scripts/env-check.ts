import { isLoginConfigured, loginPrefix, type LoginKind } from '../lib/accounts.ts';
import { getEnvironment, listEnvironmentNames, truthy } from '../lib/environments.ts';
import { coverageReport } from '../lib/memberships.ts';

/**
 * Is an environment ready to test? Prints whether each value is set, never a value.
 *   npm run env:check                 the QA_ENV environment
 *   npm run env:check -- --env=godswill
 *   npm run env:check -- --all
 */

const args = process.argv.slice(2);
const named = args.find((arg) => arg.startsWith('--env='))?.slice(6);
const names = args.includes('--all') ? listEnvironmentNames() : [named ?? process.env.QA_ENV ?? ''].filter(Boolean);

if (names.length === 0) {
  const known = listEnvironmentNames();
  console.error(`Pass --env=<name> or set QA_ENV.${known.length ? ` Configured: ${known.join(', ')}.` : ' None configured: add QA_<NAME>_BASE_URL to .env.'}`);
  process.exit(1);
}

function set(name: string): boolean {
  return Boolean((process.env[name] ?? '').trim());
}

let ready = true;
for (const name of names) {
  try {
    const env = getEnvironment(name);
    console.log(`\nEnvironment ${env.name}: ${env.baseUrl}${env.productionProtected ? `  PROTECTED${truthy(process.env.QA_ALLOW_PRODUCTION) ? ' (override on)' : ' (refused)'}` : ''}`);
    for (const kind of ['main', 'super_admin'] as LoginKind[]) {
      const prefix = loginPrefix(env.name, kind);
      const label = kind === 'main' ? 'Main login ' : 'Super admin';
      const login = isLoginConfigured(env.name, kind) ? 'configured' : `missing (${prefix}_USERNAME / _PASSWORD)`;
      const seed = set(`${prefix}_TOTP_SECRET`) ? 'seed set' : `no seed (${prefix}_TOTP_SECRET)`;
      console.log(`  ${label}: ${login}, ${seed}`);
      if (kind === 'main' && !isLoginConfigured(env.name, kind)) ready = false;
    }
    for (const line of coverageReport(env.name)) {
      console.log(`  ${line}`);
    }
  } catch (error) {
    console.log(`\n${(error as Error).message}`);
    ready = false;
  }
}
process.exit(ready ? 0 : 1);
