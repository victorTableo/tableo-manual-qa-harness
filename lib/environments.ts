import 'dotenv/config';
import { devices, type BrowserContextOptions } from '@playwright/test';

export interface Environment {
  name: string;
  baseUrl: string;
  productionProtected: boolean;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function truthy(value: string | undefined): boolean {
  return TRUTHY.has((value ?? '').trim().toLowerCase());
}

/** Show the browser while tests run: QA_WATCH=1 (QA_HEADED=1 is accepted too). */
export function watching(): boolean {
  return truthy(process.env.QA_WATCH) || truthy(process.env.QA_HEADED);
}

/** Milliseconds each browser action is slowed by while watching (QA_SLOWMO, default 400); 0 when not watching. */
export function slowMo(): number {
  if (!watching()) return 0;
  const raw = (process.env.QA_SLOWMO ?? '').trim();
  return raw !== '' && Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : 400;
}

/** Browser window size: QA_VIEWPORT=WIDTHxHEIGHT, default 1920x1080 (standard desktop). */
export function viewport(): { width: number; height: number } {
  const match = (process.env.QA_VIEWPORT ?? '').trim().match(/^(\d{3,4})\s*x\s*(\d{3,4})$/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1920, height: 1080 };
}

/**
 * Screen sizes a check can ask for. Desktop is the default for every case; the others
 * are used only when the ticket demands it (mobile, tablet, responsive, a device or width).
 * Tablet and mobile are real device presets: touch, isMobile, user agent, pixel density.
 */
export const DEVICES = ['desktop', 'tablet', 'tablet-landscape', 'mobile'] as const;
export type Device = (typeof DEVICES)[number];

const PRESETS: Record<Exclude<Device, 'desktop'>, string> = {
  tablet: 'iPad Mini',
  'tablet-landscape': 'iPad Mini landscape',
  mobile: 'iPhone 13',
};

export function deviceOptions(device: Device = 'desktop'): BrowserContextOptions {
  if (device === 'desktop') return { viewport: viewport() };
  const { defaultBrowserType: _ignored, ...preset } = devices[PRESETS[device]]!;
  return preset;
}

/** "Mobile (390×664)": for reports and screenshot names. */
export function deviceLabel(device: Device): string {
  const size = deviceOptions(device).viewport;
  const name = device.charAt(0).toUpperCase() + device.slice(1).replace('-', ' ');
  return size ? `${name} (${size.width}×${size.height})` : name;
}

/** "staging-a" -> "STAGING_A", the infix of every variable for that environment. */
export function environmentKey(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

function read(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Every environment with a QA_<ENV>_BASE_URL. Read lazily, so tests can add one at runtime. */
export function listEnvironmentNames(): string[] {
  return Object.keys(process.env)
    .map((key) => key.match(/^QA_(.+)_BASE_URL$/)?.[1])
    .filter((key): key is string => Boolean(key) && Boolean(read(`QA_${key}_BASE_URL`)))
    .map((key) => key.toLowerCase().replace(/_/g, '-'))
    .sort();
}

export function getEnvironment(name: string): Environment {
  const key = environmentKey(String(name ?? ''));
  if (!key) {
    throw new ConfigurationError('No environment name was provided.');
  }
  const baseUrl = read(`QA_${key}_BASE_URL`).replace(/\/+$/, '');
  if (!baseUrl) {
    const known = listEnvironmentNames();
    throw new ConfigurationError(
      `BLOCKED: environment "${name}" is not configured: QA_${key}_BASE_URL is not set in .env` +
        `${known.length ? ` (configured: ${known.join(', ')})` : ''}. Never guess a URL.`,
    );
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ConfigurationError(`QA_${key}_BASE_URL must start with http:// or https:// (got "${baseUrl}").`);
  }
  return {
    name: key.toLowerCase().replace(/_/g, '-'),
    baseUrl,
    productionProtected: truthy(process.env[`QA_${key}_PRODUCTION`]),
  };
}

/** The environment named by QA_ENV. */
export function getSelectedEnvironment(): Environment {
  const selected = read('QA_ENV');
  if (!selected) {
    const known = listEnvironmentNames();
    throw new ConfigurationError(
      `QA_ENV is not set${known.length ? `. Configured environments: ${known.join(', ')}` : ''}. Set QA_ENV=<name>.`,
    );
  }
  return getEnvironment(selected);
}

/**
 * Hard safety gate, enforced whenever a browser context is created: a protected
 * environment is refused unless QA_ALLOW_PRODUCTION=1 is set in the shell.
 */
export function assertEnvironmentTestable(env: Environment): void {
  if (env.productionProtected && !truthy(process.env.QA_ALLOW_PRODUCTION)) {
    throw new ConfigurationError(
      `BLOCKED: environment "${env.name}" (${env.baseUrl}) is protected (QA_${environmentKey(env.name)}_PRODUCTION=1). ` +
        'Set QA_ALLOW_PRODUCTION=1 to override deliberately, or use a non-production environment.',
    );
  }
}
