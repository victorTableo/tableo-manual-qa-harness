import { APP, appRoleLabel, planLabel } from '../config/app.ts';
import { ConfigurationError, environmentKey, getEnvironment } from './environments.ts';
import { describeMembership, findMembership, readDiscovery, type Restaurant } from './memberships.ts';

/**
 * Who a check runs as.
 *
 * Each environment has two logins in .env:
 *   main         QA_<ENV>_USERNAME / _PASSWORD / _TOTP_SECRET
 *                one person holding many restaurants, with a role in each
 *   super_admin  QA_<ENV>_SUPER_ADMIN_USERNAME / _PASSWORD / _TOTP_SECRET
 *
 * A restaurant role (manager, readonly, ...) is satisfied by the main login in a
 * restaurant where it has that role (lib/memberships.ts). When none exists the
 * check is BLOCKED and the error says what the QA engineer must set up. Never
 * substitute another role, plan, restaurant, or environment.
 *
 * TestAccount carries the password: never log it, never report it.
 */

export const ROLES = ['super_admin', 'restaurant_admin', 'manager', 'readonly', 'booker'] as const;
export type Role = (typeof ROLES)[number];
export type LoginKind = 'main' | 'super_admin';

export interface Identity {
  environment: string;
  role: Role;
  /** App plan label, any case ("grow", "Gold"). Omit when any plan will do. */
  plan?: string;
  /** Restaurant name or slug, to pin one restaurant. */
  restaurant?: string;
}

export interface TestAccount {
  environment: string;
  role: Role;
  plan?: string;
  restaurant?: Restaurant;
  login: LoginKind;
  username: string;
  password: string;
  /** Variable holding the TOTP seed. Never the seed itself. */
  totpVariable: string;
}

/** BLOCKED: the check cannot run until someone configures something. `action` says what. */
export class AccountNotConfiguredError extends ConfigurationError {
  readonly action?: string;
  constructor(message: string, action?: string) {
    super(action ? `${message} ${action}` : message);
    this.name = 'AccountNotConfiguredError';
    this.action = action;
  }
}

export function loginPrefix(environment: string, kind: LoginKind): string {
  const key = `QA_${environmentKey(environment)}`;
  return kind === 'main' ? key : `${key}_SUPER_ADMIN`;
}

/** Session cache key for a login, e.g. "devrms__main". */
export function loginKey(environment: string, kind: LoginKind): string {
  return `${getEnvironment(environment).name}__${kind}`;
}

function read(name: string): string {
  return (process.env[name] ?? '').trim();
}

export function isLoginConfigured(environment: string, kind: LoginKind): boolean {
  const prefix = loginPrefix(environment, kind);
  return Boolean(read(`${prefix}_USERNAME`) && read(`${prefix}_PASSWORD`));
}

/** Credentials of one login. Throws BLOCKED naming the variables when unset. */
export function getLogin(environment: string, kind: LoginKind): Pick<TestAccount, 'environment' | 'login' | 'username' | 'password' | 'totpVariable'> {
  const env = getEnvironment(environment);
  const prefix = loginPrefix(env.name, kind);
  if (!isLoginConfigured(env.name, kind)) {
    throw new AccountNotConfiguredError(
      `BLOCKED: the ${kind === 'main' ? 'main' : 'super admin'} login for "${env.name}" is not configured.`,
      `Set ${prefix}_USERNAME, ${prefix}_PASSWORD and ${prefix}_TOTP_SECRET in .env.`,
    );
  }
  return {
    environment: env.name,
    login: kind,
    username: read(`${prefix}_USERNAME`),
    password: read(`${prefix}_PASSWORD`),
    totpVariable: `${prefix}_TOTP_SECRET`,
  };
}

/** What the QA engineer has to do so the main login covers this identity. */
function missingMembership(identity: Identity): AccountNotConfiguredError {
  const env = getEnvironment(identity.environment);
  const role = appRoleLabel(identity.role);
  const where = [identity.plan && `on the "${planLabel(identity.plan.toLowerCase())}" plan`, identity.restaurant && `named "${identity.restaurant}"`]
    .filter(Boolean)
    .join(' ');
  const record = readDiscovery(env.name);
  const has = record
    ? record.memberships.length
      ? `It has: ${record.memberships.map(describeMembership).join(', ')}.`
      : 'It has no usable restaurant.'
    : 'Its restaurants have not been discovered yet.';
  const unusable = record?.excluded.length
    ? ` Not usable: ${record.excluded.map((x) => `${x.restaurant} (${x.reason})`).join('; ')}.`
    : '';
  return new AccountNotConfiguredError(
    `BLOCKED: no restaurant where the "${env.name}" login (${loginPrefix(env.name, 'main')}_USERNAME) is ${role}${where ? ` ${where}` : ''}. ${has}${unusable}`,
    `To test this, give that login the "${role}" role in a restaurant${where ? ` ${where}` : ''} ` +
      `(${APP.restaurants.howToGrantRole}) and re-run; restaurants are re-discovered automatically.`,
  );
}

/** Resolves the account for an identity. Throws AccountNotConfiguredError (BLOCKED). */
export function getTestAccount(identity: Identity): TestAccount {
  const env = getEnvironment(identity.environment);
  const plan = identity.plan?.trim().toLowerCase() || undefined;
  if (identity.role === 'super_admin') {
    const login = getLogin(env.name, 'super_admin');
    return { ...login, role: 'super_admin', ...(identity.restaurant ? { restaurant: { name: identity.restaurant } } : {}) };
  }
  const login = getLogin(env.name, 'main');
  const membership = findMembership(env.name, identity.role, plan, identity.restaurant);
  if (!membership) {
    throw missingMembership({ ...identity, environment: env.name });
  }
  return { ...login, role: identity.role, plan: membership.plan, restaurant: membership.restaurant };
}

/** Secret-free view for reports. */
export interface AccountRef {
  environment: string;
  role: string;
  plan?: string;
  restaurant?: string;
  login?: LoginKind;
}

export function describeAccount(account: TestAccount): AccountRef {
  return {
    environment: account.environment,
    role: account.role,
    ...(account.plan ? { plan: account.plan } : {}),
    ...(account.restaurant ? { restaurant: account.restaurant.name } : {}),
    login: account.login,
  };
}

export function describeIdentity(identity: Identity): AccountRef {
  return {
    environment: identity.environment,
    role: identity.role,
    ...(identity.plan ? { plan: identity.plan.toLowerCase() } : {}),
    ...(identity.restaurant ? { restaurant: identity.restaurant } : {}),
  };
}
