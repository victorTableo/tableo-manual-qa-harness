# tableo-manual-qa-harness

A manual QA harness for Tableo: the Playwright toolkit and `/qa` workflow that Claude Code uses to
test tickets. Give Claude a ticket; it signs in to a developer environment, tests every requirement it
can in a real browser, and reports what passed, what failed, and what it could not test, with why and
what to do about it.

## Setup (once)

**1. Install**

```bash
npm install
npx playwright install chromium
cp .env.example .env
sudo apt install zbar-tools        # or: brew install zbar   (reads QR codes)
```

**2. Fill in `.env`**

Each developer environment is one block, named after the developer:

```bash
QA_ENV=devrms                                  # default environment

QA_DEVRMS_BASE_URL=https://devrms.tableo.com
QA_DEVRMS_USERNAME=...                          # main login: one person, many restaurants
QA_DEVRMS_PASSWORD=...
QA_DEVRMS_TOTP_SECRET=...                       # Google Authenticator seed, step 3
QA_DEVRMS_SUPER_ADMIN_USERNAME=...              # the environment's super admin
QA_DEVRMS_SUPER_ADMIN_PASSWORD=...
QA_DEVRMS_SUPER_ADMIN_TOTP_SECRET=...
```

Another developer is another block (`QA_GODSWILL_BASE_URL=...`, `QA_GODSWILL_USERNAME=...`). `.env.example`
has empty blocks for godswill, sean, victor, neptune and sandbox; an empty `_BASE_URL` keeps a block
inactive. No code changes.

**Production safety.** An environment counts as production only if its block sets `QA_<NAME>_PRODUCTION=1`
(nothing is guessed from the name or URL). The harness then refuses to open it and reports every check
BLOCKED, unless you deliberately run with `QA_ALLOW_PRODUCTION=1`. Developer instances leave both unset.

**3. Get the Google Authenticator seeds**

Claude computes the 6-digit codes itself; it only needs each account's seed.

1. Google Authenticator → **menu → Transfer accounts → Export accounts** → select the test
   accounts. Screenshots are blocked on that screen: photograph the QR code with another device.
2. Decode it on your machine (no upload, no files written):

   ```bash
   zbarimg export.jpg | npm run totp:decode               # list accounts, seeds hidden
   zbarimg export.jpg | npm run totp:decode -- --reveal   # print the seeds
   ```

   Several QR pages? `zbarimg page1.jpg page2.jpg | npm run totp:decode -- --reveal`

3. Copy each seed (e.g. `JBSWY3DPEHPK3PXP`) into `.env`, then delete the photo and clear the terminal.

**4. Check, and map the app**

```bash
npm run env:check            # logins and seeds set? which restaurants and roles exist?
npm run memberships          # read restaurants, roles and plans from the app (~30s)
npm run crawl                # map every admin page and what each plan sees (~1 min per plan)
```

`memberships` lists every restaurant the main login can open with its plan and the login's
role there, then a role × plan table and the combinations that do not exist yet. Runs then refresh it
by themselves once a day.

`crawl` writes `knowledge/sitemap.md`: every sidebar page (plus Account Settings with its tabs, and the public
widget), its headings, fields and buttons with selectors, and what each plan sees there (open, upgrade wall,
403, locked). It uses one restaurant per plan where the login is Administrator, so give the login the
Administrator role on a restaurant of each plan you want covered (missing plans are listed). It is read-only:
it follows links and opens tabs, never submits anything. Anything that differs from the pricing page
(`knowledge/plans.md`) is listed at the top. Re-run it after a big release; probes keep single pages current.

## Testing a ticket

In Claude Code, in this folder:

```
/qa TAB-1234 devrms
<paste the ticket text>
```

(Or just say it: "Test TAB-1234 on devrms: …".) Each request starts fresh, even for a ticket tested before:
new cases from the ticket text, no earlier results (unless you ask for a retest). Before running, Claude
shows a table of test cases:
the ticket's own, or ones **derived from the ticket text** when it has none, each with the role it
will use and any data it will change. It then runs them and replies with the report.

| Ask for | You get |
| --- | --- |
| `/qa TAB-1234 devrms` + ticket | A full run |
| `/qa retest TAB-1234` | Only what did not pass last time is re-run; earlier passes are carried over and marked |
| `/qa full retest TAB-1234` | Everything re-run |

### Where the results are

One folder per run, named by date and time:

```
artifacts/TAB-1234/
  2026-10-01_10-51AM/          first run
    report.md                  paste this into Linear
    run-notes.md               for you: changes made, lessons, full reasons
    screenshots/01-<case>.png  each one shows the URL bar and the time it was taken
  2026-10-01_02-30PM_retest/   a retest
```

### The report

`report.md` is short and pastes cleanly into Linear: the result line, who it was tested as, then
❌ failed (expected / actual in plain words / screenshot), ⛔ not tested or needs clarity (grouped under what is
needed), ✅ passed, and on a retest 🔁 what changed since the previous run. Plus:

- **💡 Also checked (not in the ticket)**: cases Claude added with judgement (e.g. the direct URL as
  well as the menu), already tested so you don't have to, plus things noticed in passing. Kept out
  of the ticket's totals.

Next to it, **`run-notes.md`** is for you, not Linear: changes made in the app (and whether they
were reverted), what the run taught the harness, and the full reasons behind anything not tested.

### It gets better with every run

After each run Claude writes what it learned back into the repo: pages it probed (`knowledge/sitemap.md`),
behaviour and quirks (`knowledge/app.md`), proven step-by-step recipes (`knowledge/playbooks.md`),
test-data needs (`config/test-data.json`), and fixes to the harness itself. Each lesson is listed in
`knowledge/CHANGELOG.md`. Knowledge is about the app, never about a ticket, so it can be reused any time;
`artifacts/` is where you see what was tested.

### Test data

Everything Claude types into the app comes from one plain file, **`config/test-data.json`**. Edit it
like a list; no code:

| Key | What | Example |
| --- | --- | --- |
| `guests` | Guest names, used in order | QA Glory, Glory QA, Glory Test, Glory Testing |
| `email.tags` | Allowed `glory+<tag>@tableo.com` tags; any other tag gets "test" added | test, guest, freemiumtest, test1 |
| `phones` | Phone numbers, used in order | +35696961234, +35696968764 |
| `randomPhone` | Pattern for a fresh number (`#` = random digit) | +3569696#### |
| `stripeCards` | Stripe test cards by purpose | success 4242…, decline 4000…0002, insufficient_funds, 3ds_required |

To use one particular number or email for a while, either say it in the request
(`/qa TAB-1234 devrms phone +35699999999`) or set it in `.env` (`QA_PHONE=+35699999999`,
`QA_EMAIL=glory+promo-test@tableo.com`); it is then used alone. An email must still say "test".

### Changes in the app

When a ticket needs bookings, add-ons, settings or a plan change, Claude makes them with that test
data and undoes them at the end of the run. What was changed (and reverted) is in `run-notes.md`,
not in the Linear report.

- **Paid add-ons and plan upgrades** are listed in the plan and wait for your yes.
- **Card details**: Claude does not type card numbers on devrms. For a plan upgrade that asks for a
  card, either save the Stripe test card 4242 4242 4242 4242 on the restaurant first, or run that
  step yourself with `QA_WATCH=1`.
- **Onboarding** needs a code sent by email/SMS, so it is always listed as manual.

### Watching and screenshot options

All in `.env` (`.env.example` lists them with their defaults), or in front of a single command:

| Setting | Values (default first) | Effect |
| --- | --- | --- |
| `QA_WATCH` | `0`, `1` | `1` shows the browser so you can watch it click through. One window is shared by every command and closes after 15 idle minutes (`npm run browser:stop` closes it now). |
| `QA_VIEWPORT` | `1920x1080` | Desktop window size; every case uses it and layout is judged at this width (smaller screens may wrap, by design). Tablet (iPad Mini 768×1024, or landscape) and mobile (iPhone 13, 390 wide) are used only when a ticket asks for them. |
| `QA_SLOWMO` | `400` | Milliseconds each action is slowed by while watching; `0` = full speed. |
| `QA_SCREENSHOT_FRAME` | `1`, `0` | `1`: every screenshot has a browser bar showing the URL visited and the time. `0`: the page only. |
| `QA_SCREENSHOT_FULL_PAGE` | `failures`, `always`, `never` | Capture the whole scrollable page instead of the visible window: only for failures, for every screenshot, or never. |
| `QA_SCREENSHOT_ON_PASS` | `1`, `0` | `0` skips the screenshot when a check passes (failures always get one). |

Example: full-page screenshots with the URL bar for everything:
`QA_SCREENSHOT_FULL_PAGE=always` (the bar is on by default).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "code was rejected" | `QA_<ENV>_TOTP_SECRET` is not this account's seed: re-run `totp:decode` and pick the right account. Check the computer clock is synced. |
| Login stuck or "did not get past /login" | Username or password in `.env` |
| Restaurants or roles look outdated | `npm run memberships` |
| "another QA run is using devrms" | Wait for the other run, or delete the `.auth/devrms.lock` file it names if that run is gone |
| Something still looks cached | `QA_FORCE_LOGIN=1` before the command (sign-ins are normally renewed automatically) |
| Want to watch | `QA_WATCH=1` in `.env`; `QA_SLOWMO=<ms>` sets the speed |
| Browser seems stuck or stale | `npm run browser:stop`; the next command starts a fresh one |

## Commands

| Command | Purpose |
| --- | --- |
| `npm run env:check -- --env=<name>` | Configuration and restaurant coverage (`--all` for every environment) |
| `npm run probe -- --env=<name> --restaurant=<slug> <path> [<path>…]` | One-screen map of each page (headings, text under the title, tabs, controls with selectors and row), a screenshot; updates the page in the sitemap |
| `npm run crawl -- --env=<name>` | Map every admin page and what each plan sees into `knowledge/sitemap.md` (read-only) |
| `npm run qa -- tests/tmp/<TICKET>.spec.ts` | Run a ticket spec quietly: one line per check, then the report |
| `npm run browser:stop` | Close the shared browser |
| `npm run memberships -- --env=<name>` | Re-read restaurants, roles and plans |
| `npm run totp:decode` | Decode a Google Authenticator export (`--reveal` prints seeds) |
| `npm run selfcheck` | Prove the harness works, offline, ~5s |

## Safety

Credentials and seeds stay in `.env` (gitignored). Reports, logs and network dumps are
redacted, password fields are masked in screenshots, and the 2FA screen is never captured.
`artifacts/` holds real app data in screenshots: share it with care. An environment with
`QA_<ENV>_PRODUCTION=1` is refused unless `QA_ALLOW_PRODUCTION=1` is set.

Internals, extending the harness, and how the codes are generated: [docs/how-it-works.md](docs/how-it-works.md).
