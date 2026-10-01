import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { assertEnvironmentTestable, deviceOptions, getEnvironment, slowMo, truthy, watching, type Device } from './environments.ts';

/**
 * Browsers. Every command (qa, probe, memberships, crawl) shares one long-lived
 * browser: started on first use by scripts/browser-server.ts, it closes itself
 * after QA_BROWSER_IDLE_MINUTES (default 15) with no command connected. So a
 * session opens one window when watching, and commands skip the browser start.
 * QA_SHARED_BROWSER=0 (or any failure to start or reach it) falls back to a
 * browser of the command's own.
 */

const AUTH_DIR = path.resolve(process.cwd(), '.auth');
export const SHARED_INFO = path.join(AUTH_DIR, 'browser.json');
/** One file per connected process; the server stays up while any is alive. */
export const SHARED_CLIENTS = path.join(AUTH_DIR, 'browser-clients');
const STARTING = path.join(AUTH_DIR, 'browser.starting');
/** Written when the shared browser would not start: commands skip it for a while instead of waiting each time. */
const FAILED = path.join(AUTH_DIR, 'browser.failed');
const FAILED_SKIP_MS = 10 * 60_000;

interface SharedInfo {
  wsEndpoint: string;
  pid: number;
  headless: boolean;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readInfo(): SharedInfo | null {
  try {
    const info = JSON.parse(readFileSync(SHARED_INFO, 'utf8')) as SharedInfo;
    return alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

/** A browser of this process only, closed with it. */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: !watching(), slowMo: slowMo() });
}

async function startServer(headless: boolean): Promise<SharedInfo | null> {
  mkdirSync(AUTH_DIR, { recursive: true });
  // One starter at a time; a marker older than 30s was left by a starter that died.
  const claim = () => {
    try {
      closeSync(openSync(STARTING, 'wx'));
      return true;
    } catch {
      return false;
    }
  };
  let starter = claim();
  if (!starter && existsSync(STARTING) && Date.now() - statSync(STARTING).mtimeMs > 30_000) {
    rmSync(STARTING, { force: true });
    starter = claim();
  }
  if (starter) {
    const script = fileURLToPath(new URL('../scripts/browser-server.ts', import.meta.url));
    spawn(process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: { ...process.env, QA_WATCH: headless ? '0' : '1' },
    }).unref();
  }
  try {
    for (const until = Date.now() + 20_000; Date.now() < until; ) {
      const info = readInfo();
      if (info && info.headless === headless) {
        rmSync(FAILED, { force: true });
        return info;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    writeFileSync(FAILED, new Date().toISOString());
    return null;
  } finally {
    if (starter) rmSync(STARTING, { force: true });
  }
}

function register(browser: Browser): void {
  mkdirSync(SHARED_CLIENTS, { recursive: true });
  const file = path.join(SHARED_CLIENTS, String(process.pid));
  writeFileSync(file, '');
  const remove = () => rmSync(file, { force: true });
  browser.on('disconnected', remove);
  process.once('exit', remove);
}

/**
 * The shared browser (started when needed), else a browser of this process.
 * `close()` on the result disconnects from the shared one and closes this
 * process's contexts; the browser itself stays up for the next command.
 */
export async function getBrowser(): Promise<Browser> {
  const shared = (process.env.QA_SHARED_BROWSER ?? '').trim();
  if (shared !== '' && !truthy(shared)) return launchBrowser();
  if (existsSync(FAILED) && Date.now() - statSync(FAILED).mtimeMs < FAILED_SKIP_MS) return launchBrowser();
  const headless = !watching();
  try {
    let info = readInfo();
    if (info && info.headless !== headless) {
      // QA_WATCH changed: replace the server so the window shows (or hides) as asked, unless
      // another command is using it; then this command takes a browser of its own.
      if (sharedClients() > 0) return launchBrowser();
      stopSharedBrowser();
      info = null;
    }
    info ??= await startServer(headless);
    if (info) {
      const browser = await chromium.connect(info.wsEndpoint, { slowMo: slowMo(), timeout: 10_000 });
      register(browser);
      return browser;
    }
  } catch {
    // Unreachable or half-started: use a browser of our own.
  }
  return launchBrowser();
}

/** Stops the shared browser, if one is running. */
export function stopSharedBrowser(): boolean {
  const info = readInfo();
  if (info) {
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  rmSync(SHARED_INFO, { force: true });
  return Boolean(info);
}

/** Processes connected to the shared browser right now (dead ones pruned). */
export function sharedClients(): number {
  if (!existsSync(SHARED_CLIENTS)) return 0;
  let count = 0;
  for (const name of readdirSync(SHARED_CLIENTS)) {
    if (alive(Number(name))) count += 1;
    else rmSync(path.join(SHARED_CLIENTS, name), { force: true });
  }
  return count;
}

/** The only place browser contexts are created, so the production gate always applies. */
export async function createContext(
  browser: Browser,
  options: { environment: string; storageState?: string; device?: Device },
): Promise<BrowserContext> {
  const env = getEnvironment(options.environment);
  assertEnvironmentTestable(env);
  return browser.newContext({
    ...deviceOptions(options.device),
    baseURL: env.baseUrl,
    storageState: options.storageState,
    locale: process.env.QA_LOCALE ?? 'en-GB',
    timezoneId: process.env.QA_TIMEZONE ?? 'Europe/London',
    acceptDownloads: true,
  });
}
