import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { APP } from '../config/app.ts';
import {
  AccountNotConfiguredError,
  getLogin,
  getTestAccount,
  loginKey,
  type Identity,
  type LoginKind,
  type TestAccount,
} from './accounts.ts';
import { getEnvironment, truthy, type Device } from './environments.ts';
import { createContext } from './browser.ts';
import { redact, registerSecret } from './report.ts';
import { currentCode } from './totp.ts';

/**
 * Signing in: email + password, then the Google Authenticator code computed
 * from the seed in .env. Sessions are cached per login under .auth/, so a whole
 * ticket costs one sign-in per login.
 *
 * Never screenshot the MFA form: on any failure during the second factor the
 * page leaves it before the error is thrown.
 */

const AUTH_DIR = path.resolve(process.cwd(), '.auth');

export class LoginFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginFailedError';
  }
}

export function sessionTtlMinutes(): number {
  const raw = Number(process.env.QA_SESSION_TTL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 8 * 60;
}

export function sessionPath(environment: string, kind: LoginKind = 'main'): string {
  return path.join(AUTH_DIR, `${loginKey(environment, kind)}.json`);
}

export function hasFreshSession(environment: string, kind: LoginKind = 'main'): boolean {
  const file = sessionPath(environment, kind);
  if (truthy(process.env.QA_FORCE_LOGIN) || !existsSync(file)) {
    return false;
  }
  return (Date.now() - statSync(file).mtimeMs) / 60_000 <= sessionTtlMinutes();
}

/** Forces the next use of this login to sign in again (for signed-out checks). */
export function clearCachedSession(environment: string, kind: LoginKind = 'main'): void {
  rmSync(sessionPath(environment, kind), { force: true });
  rmSync(`${sessionPath(environment, kind)}.checked`, { force: true });
}

/**
 * A saved session proven signed in this recently is trusted without opening a page
 * (QA_SESSION_RECHECK_MINUTES, default 10; 0 always checks).
 */
function recentlyChecked(environment: string, kind: LoginKind): boolean {
  const raw = Number(process.env.QA_SESSION_RECHECK_MINUTES);
  const minutes = Number.isFinite(raw) && raw >= 0 && process.env.QA_SESSION_RECHECK_MINUTES?.trim() ? raw : 10;
  const file = `${sessionPath(environment, kind)}.checked`;
  return minutes > 0 && existsSync(file) && (Date.now() - statSync(file).mtimeMs) / 60_000 <= minutes;
}

/** The app signed this login out (a page landed on /login): the next use checks, and signs in again if needed. */
export function forgetSessionCheck(environment: string, kind: LoginKind = 'main'): void {
  rmSync(`${sessionPath(environment, kind)}.checked`, { force: true });
}

function markChecked(environment: string, kind: LoginKind): void {
  writeFileSync(`${sessionPath(environment, kind)}.checked`, '');
}

/** The app's own error text, verbatim. Never includes input values. */
async function visibleErrorText(page: Page): Promise<string | null> {
  const texts = await page
    .locator('[role="alert"], .invalid-feedback, .alert-danger, .text-danger, .text-red-500, .text-red-600')
    .filter({ hasText: /\S/ })
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.map((text) => text.trim().replace(/\s+/g, ' ')).find(Boolean)?.slice(0, 200) ?? null;
}

async function secondFactor(page: Page, account: Pick<TestAccount, 'environment' | 'login' | 'totpVariable'>): Promise<void> {
  const seed = (process.env[account.totpVariable] ?? '').trim();
  if (!seed) {
    throw new AccountNotConfiguredError(
      `BLOCKED: the app asked the ${account.login} login on "${account.environment}" for a Google Authenticator code, but no seed is set.`,
      `Set ${account.totpVariable} in .env (recover it with: npm run totp:decode).`,
    );
  }
  registerSecret(seed);
  const form = page.locator(APP.mfa.form).first();
  const code = await currentCode(seed);
  // The code is not registered for redaction: a bare 6-digit value would mask
  // real numbers in evidence. It expires in 30s and is never written anywhere.
  const field = form.locator(APP.mfa.code);
  await field.fill(code);
  await form.locator(APP.mfa.trustDevice).check().catch(() => undefined);
  // The page is replaced after the POST; wait for the filled field to go away so
  // the old page is never mistaken for a rejection.
  const filled = await field.elementHandle();
  await form.locator(APP.mfa.submit).click();
  await filled?.waitForElementState('hidden', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  if (await page.locator(APP.mfa.form).first().isVisible().catch(() => false)) {
    const body = await page.locator('body').innerText().catch(() => '');
    const shown = body.includes(APP.mfa.rejectedText) ? APP.mfa.rejectedText : await visibleErrorText(page);
    throw new LoginFailedError(
      `The Google Authenticator code for the ${account.login} login on "${account.environment}" was rejected` +
        `${shown ? `: "${shown}"` : ''}. ${account.totpVariable} is probably not the seed for this login.`,
    );
  }
}

/** Signs in on the given page. */
export async function login(page: Page, account: Pick<TestAccount, 'environment' | 'login' | 'username' | 'password' | 'totpVariable'>): Promise<void> {
  registerSecret(account.username);
  registerSecret(account.password);
  await page.goto(APP.login.path, { waitUntil: 'domcontentloaded' });
  await page.locator(APP.login.username).fill(account.username);
  await page.locator(APP.login.password).fill(account.password);
  await page.locator(APP.login.submit).click();
  const landed = await page
    .waitForURL((url) => url.pathname.startsWith(APP.login.signedInPath) || url.pathname.startsWith(APP.mfa.path), { timeout: 20_000 })
    .then(() => true, () => false);
  if (!landed) {
    const shown = await visibleErrorText(page);
    throw new LoginFailedError(
      `Sign-in for the ${account.login} login on "${account.environment}" did not get past ${new URL(page.url()).pathname}` +
        `${shown ? `: "${shown}"` : ''}. Check its username and password in .env.`,
    );
  }
  if (new URL(page.url()).pathname.startsWith(APP.mfa.path)) {
    try {
      await secondFactor(page, account);
      await page.waitForURL((url) => url.pathname.startsWith(APP.login.signedInPath), { timeout: 20_000 });
    } catch (error) {
      await page.goto('about:blank').catch(() => undefined); // keep the MFA form out of failure screenshots
      throw error;
    }
  }
}

/** True when the context's session still reaches a signed-in page (the app may expire it early). */
async function stillSignedIn(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto(APP.login.probePath, { waitUntil: 'domcontentloaded' });
    return new URL(page.url()).pathname.startsWith(APP.login.signedInPath);
  } catch {
    return false;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * A context signed in as one login: the cached session when it still works, else a fresh sign-in.
 * Sign-in always happens at desktop size; another device reuses that session (no second sign-in).
 */
export async function getLoginContext(browser: Browser, environment: string, kind: LoginKind = 'main', device: Device = 'desktop'): Promise<BrowserContext> {
  const desktop = await desktopLoginContext(browser, environment, kind);
  if (device === 'desktop') return desktop;
  await desktop.close();
  return createContext(browser, { environment, storageState: sessionPath(environment, kind), device });
}

async function desktopLoginContext(browser: Browser, environment: string, kind: LoginKind): Promise<BrowserContext> {
  if (hasFreshSession(environment, kind)) {
    const cached = await createContext(browser, { environment, storageState: sessionPath(environment, kind) });
    if (recentlyChecked(environment, kind)) {
      return cached;
    }
    if (await stillSignedIn(cached)) {
      markChecked(environment, kind);
      return cached;
    }
    await cached.close();
    clearCachedSession(environment, kind);
  }
  const context = await createContext(browser, { environment });
  const page = await context.newPage();
  try {
    await login(page, getLogin(environment, kind));
    mkdirSync(AUTH_DIR, { recursive: true });
    await context.storageState({ path: sessionPath(environment, kind) });
    markChecked(environment, kind);
  } catch (error) {
    await context.close();
    if (error instanceof AccountNotConfiguredError || error instanceof LoginFailedError) {
      throw error;
    }
    // Not a rejection (timeout, network): a plain error, so the next check may retry.
    throw new Error(redact(`Sign-in failed unexpectedly: ${(error as Error).message}`));
  } finally {
    await page.close().catch(() => undefined);
  }
  return context;
}

/**
 * The account for an identity. When no restaurant fits, restaurants are
 * re-discovered once per process first: the QA engineer may just have granted
 * the role and re-run the check.
 */
export async function resolveAccount(browser: Browser, identity: Identity): Promise<TestAccount> {
  if (identity.role !== 'super_admin') {
    // Restaurants, roles and plans change: read them again when older than a day, before the first check needs them.
    const { readDiscovery } = await import('./memberships.ts');
    const discoveredAt = readDiscovery(getEnvironment(identity.environment).name)?.discoveredAt;
    if (discoveredAt && Date.now() - Date.parse(discoveredAt) > 24 * 60 * 60_000) {
      const { refreshOnce } = await import('./discovery.ts');
      await refreshOnce(browser, identity.environment);
    }
  }
  try {
    return getTestAccount(identity);
  } catch (error) {
    if (!(error instanceof AccountNotConfiguredError) || identity.role === 'super_admin') {
      throw error;
    }
    const { refreshOnce } = await import('./discovery.ts');
    if (await refreshOnce(browser, identity.environment)) {
      return getTestAccount(identity);
    }
    throw error;
  }
}
