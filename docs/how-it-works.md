# How it works

For whoever maintains the harness. Usage is in the [README](../README.md); the agent's rules
are in [CLAUDE.md](../CLAUDE.md) and [`/qa`](../.claude/commands/qa.md).

## The flow of a ticket

```
/qa TAB-1234 devrms + ticket
  │
  ├─ knowledge/sitemap.md ................... where each page is, its selectors, what each plan sees (no command)
  ├─ npm run probe (only pages not mapped) .. all paths in one call; writes them back to the sitemap
  ├─ tests/tmp/TAB-1234.spec.ts ............. written fresh by Claude with checklist()
  │
  └─ run.check(title, { role, plan }, steps)        lib/checklist.ts (in the shared browser, lib/browser.ts)
       ├─ environment not configured? ........... every check BLOCKED naming the variable (no separate preflight)
       ├─ resolveAccount ....................... lib/auth.ts → lib/accounts.ts → lib/memberships.ts
       │    restaurants read on another day, or none with that role/plan? re-discover once (lib/discovery.ts)
       ├─ getLoginContext ...................... one signed-in context per login, cached in .auth/
       │    login → Google Authenticator code (lib/totp.ts) → session saved
       ├─ selectRestaurant ..................... lib/restaurants.ts: chooser → exact read-back
       ├─ steps (Claude's Playwright code)
       └─ PASS / FAIL / BLOCKED / ERROR + screenshot (lib/evidence.ts)
  run.finish() → reverts recorded changes → artifacts/TAB-1234/<date_time>/report.md, printed  (lib/report.ts)
```

## Files

| Path | Responsibility |
| --- | --- |
| `config/app.ts` | Every Tableo path and selector the harness relies on, and the role-label map |
| `config/test-data.json` | Test data the QA engineer edits: guests, email tags, phones, Stripe cards |
| `config/test-data.ts` | Loads the JSON; `guestName`, `qaEmail`, `qaPhone`, `randomPhone`, `stripeCard`, `qaNote`; `QA_PHONE` / `QA_EMAIL` overrides |
| `lib/environments.ts` | Environments from `QA_<ENV>_BASE_URL`; production gate |
| `lib/accounts.ts` | Roles, identities, the two logins, `getTestAccount()`, BLOCKED errors with actions |
| `lib/memberships.ts` | Discovered restaurants (`.auth/memberships__<env>.json`), manual overrides, coverage table |
| `lib/discovery.ts` | Reads restaurants, plans and roles from the app |
| `lib/auth.ts` | Sign-in, 2FA, session cache, `resolveAccount()` |
| `lib/restaurants.ts` | Restaurant chooser, switching, exact name match |
| `lib/checklist.ts` | Ticket runner and result classification |
| `lib/report.ts` | Run folders, redaction, `report.md` / `results.json` |
| `lib/evidence.ts` | Screenshots (framed with the URL bar and time) and downloads |
| `lib/actions.ts` | Verified building blocks: phone fields, find/cancel a booking, add-on on/off, Stripe test card |
| `lib/network.ts` | Response recording for "what does the browser receive" requirements |
| `lib/browser.ts` | The shared browser (`getBrowser`, started by `scripts/browser-server.ts`) and browser contexts (always through the production gate) |
| `lib/pagemap.ts` | Reads a page's headings, tabs, tables, controls and plan wall (probe and crawl) |
| `lib/sitemap.ts` | `knowledge/sitemap.json` + `.md`: write, render, update one page |
| `lib/crawl.ts` | Read-only crawl, one Administrator restaurant per plan; compares with `knowledge/plans.md` |
| `lib/totp.ts` | Google Authenticator codes (never the same code twice) |
| `lib/lock.ts` | One run per environment at a time |
| `scripts/` | `env:check`, `memberships`, `totp:decode`, `probe` (page maps for writing checks), `crawl`, `browser-server` |
| `tests/selfcheck.spec.ts` | Offline fixture that mimics Tableo and exercises everything above |
| `knowledge/` | Pages by plan (`sitemap.md`, generated), plan entitlements from the pricing page (`plans.md`), behaviour and quirks (`app.md`), how-to recipes (`playbooks.md`), roles (`roles.md`), lessons log (`CHANGELOG.md`). Never ticket ids |
| `.auth/` | Cached sign-ins and discovered restaurants (gitignored, safe to delete) |
| `artifacts/` | Evidence per ticket (gitignored) |

## Where to change what

| Situation | Change |
| --- | --- |
| Tableo's login, 2FA, chooser, billing or team page changed | `config/app.ts`, then the same markup in `tests/selfcheck.spec.ts`, then `npm run selfcheck` |
| New role label in the app | `roleLabels` in `config/app.ts` (+ `ROLES` in `lib/accounts.ts` if it is a new role) |
| New developer environment | A `QA_<NAME>_*` block in `.env` |
| More test data (cards, phones, email tags) | `config/test-data.json` |
| Discovery cannot read a role (e.g. Team page forbidden) | A `MANUAL` entry in `lib/memberships.ts` |
| New kind of evidence | A function in `lib/evidence.ts` writing to `artifactPath(...)` |
| Different report layout | `buildReport()` in `lib/report.ts` |
| New result rule (e.g. treat X as BLOCKED) | the `catch` in `check()` in `lib/checklist.ts` |

After any harness change: `npm run typecheck && npm run selfcheck`.

## Runs, retests and the report

- `checklist(browser, ticket, options)` starts a run; its folder `artifacts/<TICKET>/<YYYY-MM-DD_hh-mmAM>`
  (plus `_retest`) is created on first use. `results.json` holds every result and the run metadata.
- `retest: 'failed'` reads the newest earlier `results.json` of the ticket; a `check()` whose title
  passed there is recorded as carried over (its screenshot path points into that folder) without running.
  The report lists every status change since that run.
- Output per run: `report.md` (Linear: results only; printed at the end of `npm run qa`), `run-notes.md`
  (internal: changes, lessons, full reasons incl. the matcher detail behind a FAIL, slow checks), `results.json`.
  `run.learned(text, file)` also appends `- <date>: <lesson> → <file>` to `knowledge/CHANGELOG.md` (no ticket id).
- Only a retest reads earlier runs. A fresh request never does, so its report has no "changes since" section.
- FAIL "Actual" is the check's `note()` when given, else the failed matcher as a sentence (`assertionText`:
  `"Requires Grow" is not visible`, `"X" found 4 times (expected 0)`, `the page shows "…" (expected "…")`).
- `ctx.change(what, undo?)` records a change in the app; `finish()` runs the undos newest-first in a
  fresh page of the same login and restaurant, and the report says reverted ✔ / not reverted ✘ / left in place.
- Extra cases carry `extra: { why }`; the report keeps them in their own section and out of the totals.
- Screenshots: the page is captured (password fields masked), then drawn under a browser-style bar with
  the URL and local time in a scratch page, so the page under test is never altered. `screenshotSettings()`
  in `lib/evidence.ts` reads `QA_SCREENSHOT_FRAME`, `QA_SCREENSHOT_FULL_PAGE` and `QA_SCREENSHOT_ON_PASS`;
  `capture(page, name, kind)` takes `'pass' | 'failure' | 'step'` so the full-page rule can differ by kind.
- Watching: `QA_WATCH=1` (or the older `QA_HEADED=1`) shows the browser; `QA_SLOWMO` (default 400 ms when
  watching) slows each action. Both read by `watching()` / `slowMo()` in `lib/environments.ts`.

## Shared browser

`getBrowser()` connects to the browser recorded in `.auth/browser.json`. If none is running, it starts
`scripts/browser-server.ts` detached (`chromium.launchServer`, headed when `QA_WATCH`). Each connected process
leaves a pid file in `.auth/browser-clients/`. The server exits `QA_BROWSER_IDLE_MINUTES` (15) after the last one
leaves, or when its window is closed. A `QA_WATCH` change replaces the server. Anything unexpected falls back to
a private `chromium.launch`. `close()` on a connected browser closes only that process's contexts. The `checklist`
fixture uses it in place of Playwright's own `browser`, so `npm run qa` opens no extra window. Saved sign-ins
proven less than `QA_SESSION_RECHECK_MINUTES` (10) ago skip the "still signed in?" page (`.auth/<login>.json.checked`).

## Devices

Every check runs at desktop (`QA_VIEWPORT`, 1920×1080). `run.check(…, { device })` with `tablet`,
`tablet-landscape` or `mobile` (only when the ticket demands it) uses a Playwright device preset
(`DEVICES` / `deviceOptions` in `lib/environments.ts`: iPad Mini, iPhone 13) with touch, `isMobile` and
the user agent. `getLoginContext(…, device)` signs in at desktop and opens the device context from the saved
session, so there is no second sign-in and no 2FA page at phone size. Contexts are cached per
`<env>:<login>:<device>`. The result carries `device`, the report adds e.g. `· Mobile (390×664)`, and a
retest only carries over a pass of the same device.

## Crawl

`npm run crawl` (`lib/crawl.ts`) picks one Administrator restaurant per plan from the memberships cache. For
each one, it switches restaurant and reads the sidebar. Then it visits the union of all sidebar paths, plus
Account Settings and `/widget/<slug>` signed out, as every restaurant. It follows GET links and clicks in-page
tabs, never forms or action buttons, and `SKIP` drops action-like links (delete, cancel, logout, export,
switch-plan, …). Per page it records the structure, taken from the restaurant with the most open pages. Table
rows and field values are left out, and the restaurant is replaced by `<slug>`/`<restaurant>`. It also records an
access cell per plan: `open`, `wall: …`, HTTP status, `redirect → …`, plus 🔒 (locked in the sidebar) or
`(not in sidebar)`. It then compares current-plan cells with the Admin path column of `knowledge/plans.md`.
`npm run probe` replaces a single page's structure and sets its plan's access cell.

## Safeguards

| Risk | Guard |
| --- | --- |
| App expired a saved sign-in | `getLoginContext` opens `APP.login.probePath` (unless proven < 10 min ago); a check whose page lands on `/login` drops that proof and the login's contexts and signs in again once |
| Broken discovery wipes the restaurant cache | `discoverMemberships` throws, keeping the cache, when it lands on `/login` or reads nothing |
| Two restaurants share a name | `selectRestaurant` confirms by slug (`?<slug>` or `APP.restaurants.slugLink`) and tries same-named options in turn |
| A wrong selector reported as an app bug | an assertion on a missing element is ERROR unless `{ selectorVerified: true }` |
| Spec crashes or times out | the `checklist` fixture calls `finish()` (undo + report); checks stop 3 minutes before the timeout |
| Bad credentials hammer the login | a rejected login is cached for the run; tried once |
| Same 2FA code used twice | `currentCode` waits for the next 30-second window (`.auth/totp-steps.json`, hashed per seed) |
| Two runs on one environment | `lib/lock.ts` (`.auth/<env>.lock`); the restaurant is re-read after each check's steps |
| Crawl changes app data | GET links and in-page tabs only; `SKIP` drops action-like links; self-check counts hits on them (must be 0) |
| Retest mixes environments or roles | carry-over matches environment, title, role, and plan / restaurant |

## Discovery

`lib/discovery.ts`, read-only, ~30s:

1. `/admin/restaurants` gives every restaurant the login administers (name + slug) in one page.
   If no restaurant is active the app redirects to the chooser, so one is opened first.
2. For each slug, in parallel: the plan from `#current-plan-name` on the billing page (filled
   in by script, so it waits for text) and the login's role from the "Roles" column on Team
   Management.
3. Chooser entries missing from the list (restaurants where the login is not an admin, chains)
   are opened one by one to learn their slug; chains open no restaurant and are excluded.

Anything unreadable is listed as "not usable" with the reason. Nothing is filtered by plan.

## Google Authenticator: from QR code to the same 6 digits

**What the export QR contains.** "Transfer accounts → Export" shows a QR code holding a URL:

```
otpauth-migration://offline?data=<base64>
```

`data` is base64 of a small protobuf message:

```
MigrationPayload
  repeated OtpParameters otp_parameters = 1
  int32 batch_size = 3, batch_index = 4          (several QR pages when you export many accounts)
OtpParameters
  bytes  secret    = 1    the raw shared secret, e.g. 10 or 20 bytes
  string name      = 2    e.g. "qa.manager@example.com"
  string issuer    = 3    e.g. "Tableo - DevRMS"
  enum   algorithm = 4    SHA1 for Google Authenticator
  enum   digits    = 5    6
  enum   type      = 6    TOTP
```

`scripts/decode-ga-export.ts` reads that protobuf by hand (a ~40-line reader for varints and
length-prefixed fields; no dependencies) and **base32-encodes the raw secret bytes** (RFC 4648,
alphabet `A–Z2–7`, 5 bits per character). That base32 string is the "seed" you put in `.env`:
the same string a site shows under "can't scan the QR code? enter this key". The bytes are used
exactly as stored; an earlier version reversed them, which produced valid-looking seeds that
generated wrong codes.

**How the 6 digits are computed** (`lib/totp.ts`, RFC 6238, which Google Authenticator implements):

1. `key` = base32-decode the seed back to the secret bytes.
2. `counter` = `floor(unix time in seconds / 30)`, written as 8 bytes, big-endian.
3. `hash` = HMAC-SHA1(key, counter): 20 bytes.
4. Dynamic truncation: `offset` = low 4 bits of the last byte; take the 4 bytes at `offset`,
   clear the top bit → a 31-bit number.
5. `code` = that number mod 1,000,000, left-padded to 6 digits.

Google Authenticator on the phone and Tableo's server run the same five steps with the same
secret and the same 30-second counter, so all three produce the same digits; nothing is sent
between them. The harness additionally:

- waits for the next 30-second window when fewer than 2 seconds remain, so a code is never
  submitted just as it expires;
- relies on the computer clock: if codes are rejected while the phone's code works, sync the
  clock (`timedatectl`), then check that the seed belongs to that account;
- never stores or prints the code, and leaves the 2FA page before any failure screenshot.

The self-check proves both halves: the RFC 6238 test vector (`287082` at t=59s) and a public
Google Authenticator export sample decoded to its known secret.
