import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Role } from './accounts.ts';
import { APP, appRoleLabel, planLabel } from '../config/app.ts';

/**
 * Memberships: which restaurants the environment's main login can act in, with
 * which role, on which plan. They come from discovery (npm run memberships, or
 * automatically when a check needs one), cached in .auth/memberships__<env>.json.
 *
 * Every restaurant is usable whatever its plan. `plan` is the app's plan label
 * lower-cased ("freemium", "grow", "gold"...).
 *
 * MANUAL entries come first and override discovery. Use them only for what
 * discovery cannot read, e.g. a role whose Team Management page the login may
 * not open. Record only what you observed or were told.
 */

export interface Restaurant {
  name: string;
  /** Slug used in the app's URLs. */
  reference?: string;
}

export interface Membership {
  role: Role;
  plan: string;
  restaurant: Restaurant;
  source?: 'manual' | 'discovered';
}

export interface Excluded {
  restaurant: string;
  reason: string;
}

export interface DiscoveryRecord {
  environment: string;
  discoveredAt: string;
  memberships: Membership[];
  excluded: Excluded[];
}

const MANUAL: Record<string, Membership[]> = {
  // devrms: [{ role: 'booker', plan: 'grow', restaurant: { name: 'Some Restaurant', reference: 'some-slug' } }],
};

export const CACHE_DIR = path.resolve(process.cwd(), '.auth');

export function membershipCachePath(environment: string): string {
  return path.join(CACHE_DIR, `memberships__${environment}.json`);
}

export function readDiscovery(environment: string): DiscoveryRecord | null {
  const file = membershipCachePath(environment);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DiscoveryRecord;
  } catch {
    return null;
  }
}

export function normalise(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Manual entries first, then discovered ones not already listed. */
export function listMemberships(environment: string): Membership[] {
  const manual = (MANUAL[environment] ?? []).map((m) => ({ ...m, plan: normalise(m.plan), source: 'manual' as const }));
  const seen = new Set(manual.map((m) => `${m.role}|${normalise(m.restaurant.reference ?? m.restaurant.name)}`));
  const discovered = (readDiscovery(environment)?.memberships ?? []).filter(
    (m) => !seen.has(`${m.role}|${normalise(m.restaurant.reference ?? m.restaurant.name)}`),
  );
  return [...manual, ...discovered.map((m) => ({ ...m, source: 'discovered' as const }))];
}

/** First membership with this role, and this plan / restaurant when given. */
export function findMembership(
  environment: string,
  role: Role,
  plan?: string,
  restaurant?: string,
): Membership | undefined {
  const wantedPlan = normalise(plan);
  const wantedRestaurant = normalise(restaurant);
  return listMemberships(environment).find(
    (m) =>
      m.role === role &&
      (!wantedPlan || m.plan === wantedPlan) &&
      (!wantedRestaurant ||
        normalise(m.restaurant.name) === wantedRestaurant ||
        normalise(m.restaurant.reference) === wantedRestaurant),
  );
}

export function describeMembership(m: Membership): string {
  return `${appRoleLabel(m.role)} @ ${m.restaurant.name} (${planLabel(m.plan)})`;
}

/**
 * Human summary for env:check and npm run memberships: restaurants, what is not
 * usable and why, and a role x plan coverage table over the current plans plus
 * any other plan seen.
 */
export function coverageReport(environment: string): string[] {
  const record = readDiscovery(environment);
  const all = listMemberships(environment);
  const lines: string[] = [];
  if (!record && all.length === 0) {
    return [`Restaurants: not discovered yet (npm run memberships -- --env=${environment})`];
  }
  if (record) {
    const minutes = Math.round((Date.now() - Date.parse(record.discoveredAt)) / 60_000);
    lines.push(`Restaurants (discovered ${minutes} min ago):`);
  } else {
    lines.push('Restaurants (manual entries only):');
  }
  for (const m of all) {
    lines.push(`  ${describeMembership(m)}${m.restaurant.reference ? ` [${m.restaurant.reference}]` : ''}${m.source === 'manual' ? ' (manual)' : ''}`);
  }
  for (const x of record?.excluded ?? []) {
    lines.push(`  not usable: ${x.restaurant}: ${x.reason}`);
  }
  const plans = [...new Set([...APP.currentPlans, ...all.map((m) => m.plan)])];
  const roles = Object.values(APP.restaurants.roleLabels) as Role[];
  const width = Math.max(...roles.map((r) => appRoleLabel(r).length)) + 2;
  lines.push('', `Coverage (role x plan):`, `  ${''.padEnd(width)}${plans.map((p) => planLabel(p).padEnd(10)).join('')}`);
  const missing: string[] = [];
  for (const role of roles) {
    const cells = plans.map((plan) => {
      const hit = all.some((m) => m.role === role && m.plan === plan);
      if (!hit && (APP.currentPlans as readonly string[]).includes(plan)) {
        missing.push(`${appRoleLabel(role)} on ${planLabel(plan)}`);
      }
      return (hit ? 'yes' : '-').padEnd(10);
    });
    lines.push(`  ${appRoleLabel(role).padEnd(width)}${cells.join('')}`);
  }
  if (missing.length) {
    lines.push(
      '',
      `Not available on the current plans (checks needing them report BLOCKED): ${missing.join(', ')}.`,
      `To add one: ${APP.restaurants.howToGrantRole}, then re-run.`,
    );
  }
  return lines;
}
