import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * TOTP for Google Authenticator logins: RFC 6238 with GA's fixed parameters
 * (HMAC-SHA1, 6 digits, 30 second steps).
 *
 * The seed is the base32 secret printed by `npm run totp:decode`. It is
 * password-equivalent: it lives only in .env and is never logged.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, tolerant of the spaces and padding people paste in. */
export function base32Decode(input: string): Buffer {
  const normalised = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!normalised) {
    throw new Error('The TOTP seed is empty.');
  }
  if (/^OTPAUTH/.test(normalised)) {
    throw new Error('Paste the base32 secret printed by `npm run totp:decode -- --reveal`, not an otpauth URI.');
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error(`The TOTP seed is not valid base32: unexpected character "${character}".`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotp(seed: string, atMs: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / PERIOD_SECONDS)));
  const digest = createHmac('sha1', base32Decode(seed)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return binary.toString().padStart(DIGITS, '0');
}

function secondsLeftInStep(atMs = Date.now()): number {
  return PERIOD_SECONDS - Math.floor((atMs / 1000) % PERIOD_SECONDS);
}

/**
 * The last 30-second step a code was used in, per seed (stored as a hash, never the
 * seed), shared by every process: apps reject a code that was already used, so
 * two sign-ins in one step would look like a wrong seed.
 */
const USED_FILE = path.resolve(process.cwd(), '.auth', 'totp-steps.json');

function seedKey(seed: string): string {
  return createHash('sha256').update(seed.replace(/\s/g, '').toUpperCase()).digest('hex').slice(0, 16);
}

function lastUsedStep(seed: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(USED_FILE, 'utf8')) as Record<string, number>)[seedKey(seed)];
  } catch {
    return undefined;
  }
}

function markUsed(seed: string, step: number): void {
  let all: Record<string, number> = {};
  try {
    if (existsSync(USED_FILE)) all = JSON.parse(readFileSync(USED_FILE, 'utf8')) as Record<string, number>;
  } catch {
    all = {};
  }
  all[seedKey(seed)] = step;
  mkdirSync(path.dirname(USED_FILE), { recursive: true });
  writeFileSync(USED_FILE, JSON.stringify(all));
}

/** Milliseconds to wait before a fresh, unused code can be issued for this seed. */
export function waitBeforeNextCode(seed: string, safetySeconds = 2, atMs = Date.now()): number {
  const left = secondsLeftInStep(atMs);
  const step = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  return left <= safetySeconds || lastUsedStep(seed) === step ? (left + 0.25) * 1000 : 0;
}

/**
 * The current code, never one already used and never one about to expire (a code
 * computed at second 29 often arrives after the server rotated).
 */
export async function currentCode(seed: string, safetySeconds = 2): Promise<string> {
  for (let wait = waitBeforeNextCode(seed, safetySeconds); wait > 0; wait = waitBeforeNextCode(seed, safetySeconds)) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  markUsed(seed, Math.floor(Date.now() / 1000 / PERIOD_SECONDS));
  return generateTotp(seed);
}
