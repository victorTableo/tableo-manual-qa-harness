---
description: Test a ticket on a developer environment and report PASS / FAIL / BLOCKED / ERROR
argument-hint: [retest|full retest] <TICKET-ID> [env] then paste the ticket text
---

Run a manual-QA pass for this request, following CLAUDE.md:

$ARGUMENTS

## 0. Parse
- **Ticket id**: first `ABC-123` token (none → `adhoc`). **Environment**: the one named, else `QA_ENV`.
- **Every request is new.** Unless it says "retest", write a fresh spec from this ticket text. Do not open
  earlier specs, `artifacts/`, reports, or notes about this ticket. "retest" → `retest: 'failed'` (reuse
  `tests/tmp/<TICKET>.spec.ts`; only what did not pass is re-run); "full retest" → `'full'`.
- **Overrides**: a phone, email or card named in the request replaces the test-data default for this run.
  `QA_WATCH` comes from `.env` only.

## 1. Find the pages (no commands)
No preflight: the run checks the environment and logins itself, and re-reads restaurants once a day.
For each page the ticket touches, read its section in `knowledge/sitemap.md` (grep `## .*<path or area>`):
selectors, tabs, and what each plan sees. Plan tickets: `knowledge/plans.md` and `.auth/memberships__<env>.json`
(which restaurant has which plan and role). Behaviour and quirks: `knowledge/app.md`; how-tos: `knowledge/playbooks.md`.
Run `npm run probe -- --env=<env> --restaurant=<slug> <path> [<path>…]` (all pages in **one** call) only for
pages missing from the sitemap, older than 30 days, or contradicted by the ticket.

## 2. Choose test cases
- **Test what changed**: one case per distinct requirement, worded from the ticket (or derived from its text,
  naming the line). Nothing the ticket doesn't touch.
- **Vary a dimension only if the change depends on it**: plans, roles and restaurants only for permission,
  plan-gating or role tickets. A UI, layout or copy change: one restaurant, one role.
- **Desktop 1920×1080 for every case**, unless the ticket demands another size (it names mobile, tablet,
  responsive, a device or a width). Then: one case per device it names (`device: 'mobile' | 'tablet' |
  'tablet-landscape'`), or desktop + tablet + mobile when it only says "responsive". Never add device cases as
  extras. At desktop, responsive wrapping is never a FAIL; flag real breakage (overlap, cut-off, unusable) with
  `run.noticed`. At a device size, judge against what the ticket expects there.
- **Extras: at most 2** cheap regression checks of the thing that changed (`{ extra: { why } }`).
- **Needs clarity** (`run.blocked`) only when the answer would flip the result; one question each.
- Not verifiable in a browser (email, SMS, printer, third party, onboarding code) → `run.manual`.

Show `| # | Case | Who | Changes data (undo) |`, then run (wait for a yes only if it lists a purchase).

## 3. Spec and run
`tests/tmp/<TICKET>.spec.ts`, then `npm run qa -- tests/tmp/<TICKET>.spec.ts` (it prints the report):

```ts
import { test, expect } from '../../lib/checklist.ts';
import { setAddon, fillPhone, newestBookingRef, cancelBooking } from '../../lib/actions.ts';
import { guestName, qaEmail, qaPhone, qaNote } from '../../config/test-data.ts';

const TICKET = `<ticket text, verbatim>`;

test('<TICKET>', async ({ checklist }) => {
  const run = checklist('<TICKET>', { environment: '<env>', title: '<short title>', source: TICKET /*, retest: 'failed' */ });
  await run.check('<case>', { role: 'restaurant_admin' /*, plan: 'grow', device: 'mobile' (only if the ticket asks) */ }, async ({ page, account, note, change }) => {
    await page.goto(`/admin/restaurants/${account.restaurant!.reference}/...`);
    await expect(page.locator('#selector-from-sitemap')).toBeVisible();
    note('<what you saw, with numbers: this becomes "Actual">');
  }, { expected: '<from the ticket, one short sentence>' });
  run.blocked('<case>', 'Needs clarity: <what you saw>', '<the one question>');
  await run.finish();
});
```

Good checks: stable ids first, then role/text; one check may assert several facts of one requirement; navigate
by URL; wait for elements, never `networkidle`. `expected` and `note()` are short plain sentences a product
manager understands. Data changes: QA test data only, each via `change(what, undo)` (recipes in playbooks);
paid add-ons and plan changes need the QA engineer's yes.

## 4. Triage
- **ERROR**: fix your step, `retest`; after two honest attempts leave it, saying what you tried. "Not on the
  page": check the screenshot; selector right → `{ selectorVerified: true }` → FAIL.
- **FAIL**: rule out wrong role/restaurant, expired session, plan limit or feature flag, hidden element, wrong
  route (404 → BLOCKED), a 500 (reproduce once with `recordNetwork`). Never weaken the expectation.
- Open screenshots only to classify a FAIL or answer a clarity question. A change "NOT reverted ✘" → fix or flag.

## 5. Learn (only if there is something new)
Write verified facts about the **app** (never the ticket id or ticket wording), then `run.learned(text, file)`:
behaviour/quirks → `knowledge/app.md`; how-tos → `knowledge/playbooks.md`; login/chooser/plan/role page changes
→ `config/app.ts` + self-check; test data → `config/test-data.json`; harness friction → `lib/` (self-check green).
Pages and selectors are saved by probe/crawl by themselves. Correct wrong entries in place.

## 6. Reply
Done = every case has a result, FAILs ruled out, ERRORs retried, changes reverted. Reply with the printed
`report.md` as is (for Linear), the run folder, and one internal line each for changes made and lessons learned.
