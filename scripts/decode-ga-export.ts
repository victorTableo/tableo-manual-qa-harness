/**
 * One-time setup utility: decode Google Authenticator's "Transfer accounts ->
 * Export accounts" QR payload into the base32 seeds that go into .env.
 *
 * The payload is base64-encoded protobuf holding each account's raw secret
 * bytes; base32-encoding those bytes gives the seed. Done locally so seeds are
 * never handed to a website. Never writes a file, never uses the network, and
 * hides seeds unless --reveal is passed. How it works: docs/how-it-works.md.
 *
 * Usage:
 *   npm run totp:decode                       # labels only, secrets redacted
 *   npm run totp:decode -- --reveal           # print seeds (needed for .env)
 *   npm run totp:decode -- --json             # machine readable
 *   zbarimg export-1.png | npm run totp:decode -- --reveal
 *   npm run totp:decode -- "otpauth-migration://offline?data=..."
 *
 * Source of the schema: https://alexbakker.me/post/parsing-google-auth-export-qr-code.html
 */

import { readFileSync } from 'node:fs';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const ALGORITHMS: Record<number, string> = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const DIGIT_COUNTS: Record<number, number> = { 0: 6, 1: 6, 2: 8 };
// OtpType in Google's migration proto: 0 unspecified, 1 HOTP, 2 TOTP.
const TYPES: Record<number, string> = { 0: 'TOTP', 1: 'HOTP', 2: 'TOTP' };

interface OtpParameters {
  secret: string;
  name?: string;
  issuer?: string;
  algorithm?: string;
  digits?: number;
  type?: string;
  counter?: number;
}

interface MigrationPayload {
  parameters: OtpParameters[];
  version?: number;
  batchSize?: number;
  batchIndex?: number;
  batchId?: number;
}

class Reader {
  private index = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get done(): boolean {
    return this.index >= this.buffer.length;
  }

  private varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.buffer[this.index++];
      if (byte === undefined) {
        throw new Error('Unexpected end of payload.');
      }
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
    }
  }

  field(): { number: number; wire: number; value?: Buffer; varint?: number } {
    const key = this.varint();
    const number = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      return { number, wire, varint: Number(this.varint()) };
    }
    if (wire === 2) {
      const length = Number(this.varint());
      const value = this.buffer.subarray(this.index, this.index + length);
      this.index += length;
      return { number, wire, value };
    }
    throw new Error(`Unsupported protobuf wire type ${wire}.`);
  }
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function parseOtpParameters(buffer: Buffer): OtpParameters {
  const reader = new Reader(buffer);
  const parameters: OtpParameters = { secret: '' };
  while (!reader.done) {
    const { number, wire, value, varint } = reader.field();
    if (wire === 2 && value) {
      const text = value.toString('utf8');
      if (number === 1) {
        // Raw secret bytes. They are NOT reversed: reversing them yields a seed
        // that produces valid-looking but wrong codes.
        parameters.secret = base32Encode(value);
      } else if (number === 2) {
        parameters.name = text;
      } else if (number === 3) {
        parameters.issuer = text;
      }
    } else if (wire === 0 && varint !== undefined) {
      if (number === 4) {
        parameters.algorithm = ALGORITHMS[varint];
      } else if (number === 5) {
        parameters.digits = DIGIT_COUNTS[varint] ?? varint;
      } else if (number === 6) {
        parameters.type = TYPES[varint];
      } else if (number === 7) {
        parameters.counter = varint;
      }
    }
  }
  // proto3 omits zero values, and 0 maps to SHA1 / 6 digits.
  parameters.algorithm ??= 'SHA1';
  parameters.digits ??= 6;
  return parameters;
}

export function decodeMigrationPayload(buffer: Buffer): MigrationPayload {
  const reader = new Reader(buffer);
  const payload: MigrationPayload = { parameters: [] };
  while (!reader.done) {
    const { number, wire, value, varint } = reader.field();
    if (wire === 2 && value) {
      if (number === 1) {
        payload.parameters.push(parseOtpParameters(value));
      }
    } else if (wire === 0 && varint !== undefined) {
      if (number === 2) {
        payload.version = varint;
      } else if (number === 3) {
        payload.batchSize = varint;
      } else if (number === 4) {
        payload.batchIndex = varint;
      } else if (number === 5) {
        payload.batchId = varint;
      }
    }
  }
  return payload;
}

function decodeUri(uri: string): MigrationPayload {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith('otpauth-migration://')) {
    throw new Error(`Not a Google Authenticator export URI: ${trimmed.slice(0, 40)}...`);
  }
  const data = new URL(trimmed).searchParams.get('data');
  if (!data) {
    throw new Error('The export URI has no data parameter.');
  }
  return decodeMigrationPayload(Buffer.from(data, 'base64'));
}

export function decodeAll(uris: string[]): { accounts: OtpParameters[]; problems: string[] } {
  const accounts: OtpParameters[] = [];
  const problems: string[] = [];
  const batchSizes = new Set<number>();
  const batchIndices = new Set<number>();

  for (const uri of uris) {
    if (!uri.trim()) {
      continue;
    }
    try {
      const payload = decodeUri(uri);
      accounts.push(...payload.parameters);
      if (payload.batchSize !== undefined) {
        batchSizes.add(payload.batchSize);
      }
      // proto3 omits a batch_index of 0, so treat absence as the first page.
      batchIndices.add(payload.batchIndex ?? 0);
      if (
        payload.batchSize !== undefined &&
        payload.batchSize > 1 &&
        (payload.batchIndex ?? 0) > 0
      ) {
        problems.push(`partial export: batch ${(payload.batchIndex ?? 0) + 1} of ${payload.batchSize}`);
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (batchSizes.size > 1) {
    problems.push('the supplied QR codes come from different export batches');
  }
  const expected = [...batchSizes][0];
  if (expected !== undefined && batchIndices.size !== expected) {
    problems.push(`expected ${expected} QR pages but received ${batchIndices.size}: scan every page`);
  }
  return { accounts, problems };
}

/* ------------------------------------------------------------------------- cli */

const invokedDirectly = process.argv[1]?.includes('decode-ga-export');

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const reveal = args.includes('--reveal');
  const asJson = args.includes('--json');
  const inline = args.filter((arg) => !arg.startsWith('--'));

  const readStdin = (): string => {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  };

  const source = inline.length > 0 ? inline.join('\n') : readStdin();
  // zbarimg prefixes every result with its symbology ("QR-Code:otpauth-..."), so
  // pull the URI out of the line instead of expecting the line to start with it.
  const uris = source
    .split('\n')
    .map((line) => line.match(/otpauth-migration:\/\/\S+/i)?.[0])
    .filter((uri): uri is string => Boolean(uri));
  const mask = (seed: string): string => (reveal ? seed : `${seed.slice(0, 2)}***${seed.slice(-2)}`);

  if (uris.length === 0) {
    console.error(
      'Nothing to decode.\n' +
        'Google Authenticator: menu -> Transfer accounts -> Export accounts -> select accounts.\n' +
        'Then either pipe the otpauth-migration:// URIs in, for example:\n' +
        '  zbarimg export-1.png | npm run totp:decode -- --reveal\n' +
        'or paste them as arguments. Never paste seeds into chat.',
    );
    process.exit(1);
  }

  const { accounts, problems } = decodeAll(uris);

  if (asJson) {
    console.log(
      JSON.stringify(
        { problems, accounts: accounts.map((account) => ({ ...account, secret: mask(account.secret) })) },
        null,
        2,
      ),
    );
  } else {
    console.log(`Decoded ${uris.length} QR page(s), ${accounts.length} account(s).`);
    for (const account of accounts) {
      const label = [account.issuer, account.name].filter(Boolean).join(' — ') || '(unlabelled)';
      const params = [
        account.type,
        account.algorithm,
        `${account.digits ?? 6} digits`,
        account.secret ? `secret ${mask(account.secret)}` : 'no secret',
      ].filter(Boolean).join(', ');
      console.log(`  ${label}: ${params}`);
      if ((account.algorithm && account.algorithm !== 'SHA1') || (account.digits && account.digits !== 6)) {
        console.log('    WARNING: not SHA1 / 6 digits; the harness only supports Google Authenticator defaults.');
      }
    }
    for (const problem of problems) {
      console.log(`  WARNING: ${problem}`);
    }
    if (!reveal) {
      console.log('\nSecrets are redacted. Re-run with --reveal when you are ready to paste them into .env.');
    }
  }

  if (problems.length > 0) {
    process.exit(2);
  }
}
