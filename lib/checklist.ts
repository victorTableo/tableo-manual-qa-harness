import { test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  AccountNotConfiguredError,
  describeAccount,
  describeIdentity,
  type Identity,
  type LoginKind,
  type TestAccount,
} from './accounts.ts';
import { readFileSync } from 'node:fs';
import { assertEnvironmentTestable, ConfigurationError, getEnvironment, getSelectedEnvironment, type Device, type Environment } from './environments.ts';
import { getBrowser } from './browser.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { forgetSessionCheck, getLoginContext, LoginFailedError, resolveAccount } from './auth.ts';
import { APP } from '../config/app.ts';
import type { Restaurant } from './memberships.ts';
import { activeRestaurant, RestaurantNotConfirmedError, sameRestaurant, selectRestaurant } from './restaurants.ts';
import {
  formatSummary,
  humanTime,
  previousRun,
  redact,
  setTicket,
  writeReport,
  type ChangeRecord,
  type ReportMeta,
  type RequirementResult,
} from './report.ts';
import { capture, screenshotSettings } from './evidence.ts';

/**
 * Runs a ticket. Every requirement is attempted and ends as PASS / FAIL / BLOCKED /
 * ERROR with evidence; nothing stops the run. Use the `test` exported here: its
 * `checklist` fixture always finishes the run (undo changes, write the report),
 * even when the test throws or times out. Template: /qa (.claude/commands/qa.md).
 */

export interface CheckContext {
  page: Page;
  account: TestAccount;
  /** Extra screenshot mid-check (e.g. before / after a change). Returns its path. */
  shot: (label: string) => Promise<string>;
  /** What was observed, for the report's "Actual" line. */
  note: (actual: string) => void;
  /**
   * Record a change made in the app (booking created, add-on switched on, setting saved).
   * With `undo`, it is reverted when the run finishes; the report says whether it worked.
   */
  change: (what: string, undo?: (page: Page) => Promise<unknown>) => void;
}

export interface CheckOptions {
  /** The expected behaviour, as the ticket states it. */
  expected?: string;
  /** A case the agent added (not in the ticket), and why it is worth checking. */
  extra?: { why: string };
  /**
   * An assertion on an element that is not on the page at all is reported as ERROR
   * (most often a wrong selector). After checking the screenshot and confirming the
   * selector is right, set this so a missing element is reported as an app FAIL.
   */
  selectorVerified?: boolean;
}

export interface ChecklistOptions {
  environment?: string;
  title?: string;
  /** The ticket text, verbatim. */
  source?: string;
  /** 'failed': re-run only what did not pass last time. 'full': re-run everything. */
  retest?: 'failed' | 'full';
}

type Who = Omit<Identity, 'environment'> & {
  environment?: string;
  /** Screen size; desktop unless the ticket demands tablet / mobile / responsive. */
  device?: Device;
};

interface PendingUndo {
  record: ChangeRecord;
  login: LoginKind;
  environment: string;
  restaurant?: Restaurant;
  undo: (page: Page) => Promise<unknown>;
}

const ANSI = /\u001b\[[0-9;]*m/g;

function onLoginPage(page: Page): boolean {
  return page.url().startsWith('http') && new URL(page.url()).pathname.startsWith(APP.login.path);
}

function firstLines(message: string, count = 3): string {
  return message.replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, count).join(' | ');
}

/** "getByText('Requires Grow')" -> '"Requires Grow"'; "getByRole('button', { name: 'Save' })" -> 'the "Save" button'. */
function target(locator: string | undefined): string {
  if (!locator || /^locator\('(body|html)'\)$/.test(locator)) return 'the page';
  const text = locator.match(/^getBy(?:Text|Label|Placeholder|Title|AltText)\((['"/])(.+?)\1[ig]*(?:,.*)?\)/);
  if (text) return `"${text[2]}"`;
  const role = locator.match(/^getByRole\('(\w+)'(?:, \{ name: (['"/])(.+?)\2[ig]* \})?\)/);
  if (role) return role[3] ? `the "${role[3]}" ${role[1]}` : `a ${role[1]}`;
  const css = locator.match(/^locator\('(.+?)'\)/);
  return css ? css[1]! : locator;
}

function short(value: string, max = 120): string {
  const clean = value.replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * What a failed assertion says, in plain words: its custom message (expect(value, 'message'))
 * when it has one, else Playwright's matcher output turned into a sentence
 * ('"Requires Grow" is not visible', '"X" found 4 times (expected 0)').
 */
export function assertionText(message: string): string {
  const all = message.replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const lines = all.slice(0, all.findIndex((l) => l === 'Call log:') + 1 || undefined);
  const first = (lines[0] ?? '').replace(/^Error:\s*/, '');
  if (!first.startsWith('expect(')) return first;
  const field = (name: RegExp) => lines.map((l) => l.match(name)?.[1]).find((v) => v !== undefined);
  const matcher = first.match(/^expect\((\w+)\)\.(not\.)?(\w+)\(/);
  if (!matcher) return firstLines(message);
  const negated = Boolean(matcher[2]);
  const name = matcher[3]!;
  const what = target(field(/^Locator:\s+(.+)$/));
  // Multi-line values come as a diff: "- Expected substring - 1" / "+ Received string + 4", then -/+ lines.
  const diff = lines.some((l) => /^- Expected/.test(l));
  const side = (sign: string) => lines.filter((l) => l.startsWith(`${sign} `) && !/^[-+] (Expected|Received)/.test(l)).map((l) => l.slice(2)).join(' ') || undefined;
  // Playwright already writes "Expected: not 0" for .not matchers; the sentence adds the "not" itself.
  const expected = (diff ? side('-') : field(/^Expected(?: [a-z ]+)?:\s+(.+)$/))?.replace(/^not\s+/, '');
  const received = (diff ? side('+') : field(/^Received(?: [a-z ]+)?:\s+(.+)$/)) ?? (lines.some((l) => /element\(s\) not found/i.test(l)) ? 'element(s) not found' : undefined);
  if (received && /element\(s\) not found/i.test(received) && !negated) return `${what} is not on the page`;
  const state: Record<string, string> = {
    toBeVisible: 'visible', toBeHidden: 'hidden', toBeEnabled: 'enabled', toBeDisabled: 'disabled',
    toBeChecked: 'checked', toBeEditable: 'editable', toBeFocused: 'focused', toBeAttached: 'on the page', toBeEmpty: 'empty',
  };
  if (state[name]) return `${what} is ${negated ? '' : 'not '}${state[name]}`;
  if (name === 'toHaveCount') return `${what} found ${received ?? '?'} times (expected ${negated ? 'not ' : ''}${expected ?? '?'})`;
  if (name === 'toHaveURL') return `the page is at ${short(received ?? '?')} (expected ${negated ? 'not ' : ''}${short(expected ?? '?')})`;
  if (name === 'toHaveTitle') return `the page title is "${short(received ?? '')}" (expected ${negated ? 'not ' : ''}"${short(expected ?? '')}")`;
  if (/^to(Have|Contain)Text$/.test(name) || name === 'toHaveValue' || name === 'toHaveAttribute') {
    const shows = name === 'toHaveValue' ? 'holds' : name === 'toHaveAttribute' ? 'has' : 'shows';
    return received && !/element\(s\) not found/i.test(received)
      ? `${what} ${shows} "${short(received)}" (expected ${negated ? 'not ' : ''}"${short(expected ?? '')}")`
      : `${what} is not on the page`;
  }
  if (expected !== undefined || received !== undefined) {
    return `got ${short(received ?? '?')} (expected ${negated ? 'not ' : ''}${short(expected ?? '?')})`;
  }
  return firstLines(message);
}

function isAssertion(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'matcherResult' in error);
}

/** Playwright's wording when the asserted locator matched nothing at all. */
function elementNotFound(message: string): boolean {
  return /element\(s\) not found/i.test(message.replace(ANSI, ''));
}

/** Same title, same role, and the same plan / restaurant when the check names them. */
function sameCase(earlier: RequirementResult, title: string, who: Who): boolean {
  if (earlier.title !== title && earlier.title !== redact(title)) return false;
  const account = earlier.account;
  if (!account) return false;
  return (
    account.role === who.role &&
    (!who.plan || account.plan === who.plan.toLowerCase()) &&
    (!who.restaurant || account.restaurant?.toLowerCase() === who.restaurant.toLowerCase()) &&
    (earlier.device ?? 'desktop') === (who.device ?? 'desktop')
  );
}

/** Time kept back from the test timeout so finish() can always undo changes and write the report. */
const FINISH_RESERVE_MS = 3 * 60_000;

export class Checklist {
  readonly results: RequirementResult[] = [];
  readonly ticket: string;
  private readonly browser: Browser;
  private readonly options: ChecklistOptions;
  private readonly env: Environment;
  /** The environment is not usable (not configured, protected): every check is BLOCKED with this. */
  private readonly configError: ConfigurationError | null = null;
  private readonly startedAt = new Date().toISOString();
  private readonly previous: ReturnType<typeof previousRun>;
  /** Keyed "<environment>:<login>": a check may target another environment than the run's. */
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly changes: ChangeRecord[] = [];
  private readonly undos: PendingUndo[] = [];
  private readonly noticedItems: Array<{ text: string; evidence?: string }> = [];
  private readonly learnedItems: Array<{ text: string; file: string }> = [];
  private readonly startMs = Date.now();
  private finished: Promise<string> | null = null;

  constructor(browser: Browser, ticket: string, options: ChecklistOptions = {}) {
    this.browser = browser;
    this.ticket = ticket;
    this.options = options;
    // The preflight lives here: a missing environment or login BLOCKS each check, naming the variable.
    let env: Environment;
    try {
      env = options.environment ? getEnvironment(options.environment) : getSelectedEnvironment();
      assertEnvironmentTestable(env);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      this.configError = error;
      env = { name: options.environment || (process.env.QA_ENV ?? '').trim() || 'unset', baseUrl: 'not configured', productionProtected: false };
    }
    this.env = env;
    // Read before this run's folder exists, so "previous" is really the last finished run here.
    this.previous = options.retest ? previousRun(ticket, this.env.name) : null;
    setTicket(ticket, options.retest ? 'retest' : '');
    base.info().setTimeout(Math.max(base.info().timeout, 30 * 60_000));
    // Last, so nothing above can throw and leave the lock behind.
    if (!this.configError) acquireLock(this.env.name);
  }

  /**
   * One signed-in context per login, shared by every check. A login the app rejected
   * (or that is not configured) stays failed for the rest of the run, so a bad
   * password or seed is tried once, not once per check.
   */
  private context(kind: LoginKind, environment = this.env.name, device: Device = 'desktop'): Promise<BrowserContext> {
    const key = `${environment}:${kind}:${device}`;
    let existing = this.contexts.get(key);
    if (!existing) {
      existing = getLoginContext(this.browser, environment, kind, device);
      existing.catch((error) => {
        if (!(error instanceof LoginFailedError || error instanceof ConfigurationError)) this.contexts.delete(key);
      });
      this.contexts.set(key, existing);
    }
    return existing;
  }

  /**
   * The app signed this login out (a page is on /login): drop the saved check and every
   * context of the login, so the next use signs in again.
   */
  private async signedOut(kind: LoginKind, environment: string): Promise<void> {
    forgetSessionCheck(environment, kind);
    for (const [key, context] of [...this.contexts]) {
      if (!key.startsWith(`${environment}:${kind}:`)) continue;
      this.contexts.delete(key);
      await context.then((c) => c.close(), () => undefined);
    }
  }

  private record(result: RequirementResult): RequirementResult {
    this.results.push(result);
    const tag = result.extra ? ' [extra]' : result.carriedFrom ? ' [carried over]' : '';
    console.log(redact(`${result.status.padEnd(7)} ${result.title}${tag}${result.reason ? ` — ${firstLines(result.reason, 1)}` : ''}`));
    return result;
  }

  async check(title: string, who: Who, run: (ctx: CheckContext) => Promise<void>, options: CheckOptions = {}): Promise<RequirementResult> {
    const earlier = this.previous?.results.find((r) => sameCase(r, title, who));
    if (this.options.retest === 'failed' && earlier?.status === 'PASS') {
      return this.record({ ...earlier, carriedFrom: earlier.carriedFrom ?? humanTime(new Date(this.previous!.startedAt)) });
    }
    if (Date.now() - this.startMs > base.info().timeout - FINISH_RESERVE_MS) {
      return this.record({
        title,
        status: 'BLOCKED',
        reason: 'Not run: the run used up its time.',
        action: 'Re-run as a retest to finish the remaining checks.',
        evidence: [],
      });
    }

    if (this.configError && !who.environment) {
      return this.record({
        title,
        status: 'BLOCKED',
        reason: this.configError.message.replace(/^BLOCKED:\s*/, ''),
        action: 'Fix the environment settings in .env named above, then re-run.',
        evidence: [],
      });
    }
    const started = Date.now();
    const { device = 'desktop', ...person } = who;
    const identity: Identity = { ...person, environment: who.environment ?? this.env.name };
    const shotTitle = device === 'desktop' ? title : `${title} ${device}`;
    const evidence: string[] = [];
    let actual: string | undefined;
    let account: TestAccount | undefined;
    let page: Page | undefined;
    const done = (result: Omit<RequirementResult, 'title' | 'evidence' | 'durationMs'>) =>
      this.record({
        title,
        ...(options.expected ? { expected: options.expected } : {}),
        ...(options.extra ? { extra: options.extra } : {}),
        account: account ? describeAccount(account) : describeIdentity(identity),
        ...(device !== 'desktop' ? { device } : {}),
        ...result,
        evidence: evidence.filter(Boolean),
        durationMs: Date.now() - started,
      });

    try {
      account = await resolveAccount(this.browser, identity);
      const owner = account;
      const open = async () => {
        const opened = await (await this.context(owner.login, owner.environment, device)).newPage();
        page = opened;
        if (owner.restaurant) await selectRestaurant(opened, owner.restaurant).catch((error) => {
          if (!onLoginPage(opened)) throw error;
        });
        return opened;
      };
      let current = await open();
      if (onLoginPage(current)) {
        // The saved sign-in stopped working (the app ended the session): sign in again, once.
        await current.close();
        await this.signedOut(owner.login, owner.environment);
        current = await open();
      }
      await run({
        page: current,
        account: owner,
        shot: async (label) => {
          const file = await capture(current, `${shotTitle} ${label}`, 'step');
          evidence.push(file);
          return file;
        },
        note: (text) => {
          actual = text;
        },
        change: (what, undo) => {
          const record: ChangeRecord = { what: `${what} (${owner.restaurant?.name ?? owner.login})`, reverted: null };
          this.changes.push(record);
          if (undo) this.undos.push({ record, login: owner.login, environment: owner.environment, restaurant: owner.restaurant, undo });
        },
      });
      // Another run sharing this session could have switched the restaurant mid-check.
      // A check that ended signed out (on purpose or not) leaves no usable session behind.
      if (onLoginPage(current)) await this.signedOut(owner.login, owner.environment);
      else if (owner.restaurant) {
        const shown = await activeRestaurant(current);
        if (shown && !sameRestaurant(shown, owner.restaurant.name)) {
          throw new RestaurantNotConfirmedError(
            `BLOCKED: the restaurant changed to "${shown}" during the check (expected "${owner.restaurant.name}").`,
            shown,
            'Make sure no other run uses this environment at the same time, then re-run.',
          );
        }
      }
      if (screenshotSettings().onPass) evidence.push(await capture(current, shotTitle, 'pass'));
      return done({ status: 'PASS', ...(actual ? { actual } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedPage = page as Page | undefined;
      if (failedPage && !failedPage.isClosed()) {
        evidence.push(await capture(failedPage, `${shotTitle} failure`, 'failure').catch(() => ''));
        if (onLoginPage(failedPage) && account) await this.signedOut(account.login, account.environment);
      }
      if (error instanceof AccountNotConfiguredError) {
        const reason = (error.action ? message.replace(error.action, '') : message).replace(/^BLOCKED:\s*/, '').trim();
        return done({ status: 'BLOCKED', reason, action: error.action });
      }
      if (error instanceof ConfigurationError) {
        return done({ status: 'BLOCKED', reason: message.replace(/^BLOCKED:\s*/, ''), action: 'Fix the environment settings in .env named above, then re-run.' });
      }
      if (error instanceof LoginFailedError) {
        return done({ status: 'BLOCKED', reason: message, action: 'Fix the login for this environment in .env, then re-run.' });
      }
      if (isAssertion(error) && elementNotFound(message) && !options.selectorVerified) {
        return done({
          status: 'ERROR',
          reason: `The element this check asserts is not on the page at all (${assertionText(message)}).`,
          action: 'Check the selector against the screenshot. If it is right, the app is missing the element: re-run with { selectorVerified: true } to report it as FAIL.',
        });
      }
      if (isAssertion(error)) {
        // What the check observed, then what failed: a note can come from an earlier step that passed.
        const failed = assertionText(message);
        return done({ status: 'FAIL', actual: actual && actual !== failed ? `${actual}. ${failed}` : failed });
      }
      return done({ status: 'ERROR', reason: firstLines(message), action: 'The automation failed, not the app: fix the step or test this by hand.' });
    } finally {
      await (page as Page | undefined)?.close().catch(() => undefined);
    }
  }

  /** A requirement a browser cannot verify here; listed for a person to test. */
  manual(title: string, reason: string, action = 'Test this by hand.'): RequirementResult {
    return this.record({ title, status: 'BLOCKED', reason: `Manual testing needed: ${reason}`, action, evidence: [] });
  }

  /** A requirement that cannot run for another reason (missing setup or data, not deployed...). */
  blocked(title: string, reason: string, action: string): RequirementResult {
    return this.record({ title, status: 'BLOCKED', reason, action, evidence: [] });
  }

  /** Something worth flagging that no requirement covers (reported under "Also checked"). */
  noticed(text: string, evidence?: string): void {
    this.noticedItems.push({ text, ...(evidence ? { evidence } : {}) });
  }

  /**
   * Something this run taught the harness, after you updated the repo file for it
   * (knowledge/app.md, knowledge/playbooks.md, config/app.ts, ...). Goes to
   * run-notes.md and knowledge/CHANGELOG.md, never to the Linear report.
   */
  learned(text: string, file: string): void {
    this.learnedItems.push({ text, file });
  }

  /** Reverts recorded changes, writes the report, closes the browsers. Safe to call twice. Returns the report path. */
  finish(): Promise<string> {
    this.finished ??= this.complete().finally(() => {
      if (!this.configError) releaseLock(this.env.name);
    });
    return this.finished;
  }

  private async complete(): Promise<string> {
    for (const pending of [...this.undos].reverse()) {
      let page: Page | undefined;
      try {
        page = await (await this.context(pending.login, pending.environment)).newPage();
        if (pending.restaurant) await selectRestaurant(page, pending.restaurant);
        await pending.undo(page);
        pending.record.reverted = true;
      } catch (error) {
        pending.record.reverted = false;
        pending.record.detail = firstLines(error instanceof Error ? error.message : String(error), 1);
      } finally {
        await page?.close().catch(() => undefined);
      }
    }
    await Promise.all([...this.contexts.values()].map((c) => c.then((context) => context.close(), () => undefined)));
    const meta: ReportMeta = {
      environment: this.env.name,
      baseUrl: this.env.baseUrl,
      title: this.options.title ?? this.previous?.title,
      source: this.options.source,
      startedAt: this.startedAt,
      changes: this.changes,
      noticed: this.noticedItems,
      learned: this.learnedItems,
      ...(this.options.retest ? { retest: { mode: this.options.retest, previousStartedAt: this.previous?.startedAt ?? null } } : {}),
    };
    const file = writeReport(this.results, meta, this.previous?.results ?? null);
    // The report itself, so whoever ran the spec needs no second command to read it.
    console.log(`\n${formatSummary(this.results.filter((r) => !r.extra))}\nReport: ${file}\n\n${readFileSync(file, 'utf8')}`);
    return file;
  }
}

export function checklist(browser: Browser, ticket: string, options: ChecklistOptions = {}): Checklist {
  return new Checklist(browser, ticket, options);
}

/**
 * Playwright's `test` with a `checklist` fixture. Every run it creates is finished
 * when the test ends, however it ends (passed, threw, timed out), so changes are
 * always undone and the report always written.
 *
 *   import { test, expect } from '../../lib/checklist.ts';
 *   test('TAB-1234', async ({ checklist }) => { const run = checklist('TAB-1234', { environment: 'devrms' }); ... });
 */
export const test = base.extend<{ checklist: (ticket: string, options?: ChecklistOptions) => Checklist }>({
  // The shared browser (lib/browser.ts), not Playwright's own: a run opens no window of its own.
  checklist: async ({}, use) => {
    const browser = await getBrowser();
    const runs: Checklist[] = [];
    try {
      await use((ticket, options = {}) => {
        const run = new Checklist(browser, ticket, options);
        runs.push(run);
        return run;
      });
      for (const run of runs) await run.finish();
    } finally {
      await browser.close().catch(() => undefined);
    }
  },
});

export { expect } from '@playwright/test';
