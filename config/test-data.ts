import { readFileSync } from 'node:fs';

/**
 * Test data the agent enters into the app, read from config/test-data.json
 * (edit that file, not this one). One-off overrides, highest first:
 *   1. passed in the spec (e.g. qaPhone() replaced by a number named in the request)
 *   2. .env: QA_PHONE=+356..., QA_EMAIL=glory+something-test@tableo.com (used alone)
 *   3. config/test-data.json
 * Never put real customer data here.
 */

interface TestData {
  guests: string[];
  email: { mailbox: string; domain: string; tags: string[] };
  phones: string[];
  randomPhone: string;
  stripeCards: Record<string, { number: string; note?: string }>;
  card: { expiry: string; cvc: string; postcode: string };
  prohibitedNetworkValues: string[];
}

function load(): TestData {
  const file = new URL('./test-data.json', import.meta.url);
  const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<TestData>;
  const missing = (['guests', 'email', 'phones', 'randomPhone', 'stripeCards', 'card'] as const).filter((key) => !data[key]);
  if (missing.length) {
    throw new Error(`config/test-data.json is missing: ${missing.join(', ')}`);
  }
  return { prohibitedNetworkValues: [], ...data } as TestData;
}

export const TEST_DATA = load();
const STARTED = Date.now();

/** A token unique to this run, e.g. to tell today's records apart. */
export function runMarker(): string {
  return `QA${STARTED.toString(36).toUpperCase()}`;
}

export function guestName(index = 0): string {
  return TEST_DATA.guests[index % TEST_DATA.guests.length]!;
}

/**
 * A test mailbox: glory+<tag>@tableo.com. The tag always says "test": tags listed
 * in the JSON are used as they are, anything else gets "test" appended
 * ("freemium" → "freemiumtest"). `true` gives an address unique to this run.
 * QA_EMAIL in .env replaces all of this.
 */
export function qaEmail(tag?: string | true): string {
  const { mailbox, domain, tags } = TEST_DATA.email;
  const override = (process.env.QA_EMAIL ?? '').trim();
  if (override) {
    const tagPart = override.split('@')[0]?.split('+')[1]?.toLowerCase() ?? '';
    if (!tagPart.includes('test') && !tags.includes(tagPart)) {
      throw new Error(`QA_EMAIL "${override}" does not signal a test: use ${mailbox}+<something with "test">@${domain}.`);
    }
    return override;
  }
  let label = tag === true ? `test${runMarker().slice(2).toLowerCase()}` : (tag ?? tags[0] ?? 'test').toLowerCase().replace(/[^a-z0-9-]+/g, '');
  if (!label.includes('test') && !tags.includes(label)) label = `${label}test`;
  return `${mailbox}+${label}@${domain}`;
}

/** QA_PHONE from .env when set (used alone), else the n-th number in the JSON. */
export function qaPhone(index = 0): string {
  const override = (process.env.QA_PHONE ?? '').trim();
  if (override) return override;
  return TEST_DATA.phones[index % TEST_DATA.phones.length]!;
}

/** A fresh number from the "randomPhone" pattern (each # becomes a digit), unless QA_PHONE is set. */
export function randomPhone(): string {
  const override = (process.env.QA_PHONE ?? '').trim();
  return override || TEST_DATA.randomPhone.replace(/#/g, () => String(Math.floor(Math.random() * 10)));
}

/** Note for bookings and free-text fields, so a record traces back to its ticket. */
export function qaNote(ticket: string): string {
  return `QA ${ticket} ${runMarker()}`;
}

/** A Stripe test card by kind ("success", "decline", ...), with expiry, CVC and postcode. */
export function stripeCard(kind = 'success'): { number: string; expiry: string; cvc: string; postcode: string } {
  const card = TEST_DATA.stripeCards[kind];
  if (!card) {
    throw new Error(`No Stripe test card "${kind}" in config/test-data.json (have: ${Object.keys(TEST_DATA.stripeCards).join(', ')}).`);
  }
  return { number: card.number, ...TEST_DATA.card };
}

/** Values that must never appear in a network response ("this data is not exposed" checks). */
export const PROHIBITED_NETWORK_VALUES: string[] = TEST_DATA.prohibitedNetworkValues;
