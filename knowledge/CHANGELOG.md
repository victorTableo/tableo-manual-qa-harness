# What the agent learned

One line per lesson, newest last: date, lesson → file updated. Lessons describe the app, never a
ticket; `artifacts/` records what was tested.

- 2026-10-01: victor sign-in, 2FA and restaurant chooser verified; routes and selectors recorded → `knowledge/app.md`
- 2026-10-01: restaurant list, plan label (filled by script) and Team roles read for discovery → `config/app.ts`
- 2026-10-01: report routes, Freemium "Upgrade Required" walls, Payments report path → `knowledge/app.md`
- 2026-10-01: Marketplace BI card shows a raw translation key; "Requires Grow" is in the markup but never visible → `knowledge/app.md`
- 2026-10-01: booking via form needs a table; phone fields need key-by-key typing → `knowledge/playbooks.md`
- 2026-10-01: Diary booking via empty cell, widget booking (arrives pending, clean up with Reject) → `knowledge/playbooks.md`
- 2026-10-01: add-on on/off flow ("Added to your profile" / "Are you sure… Disable") → `knowledge/playbooks.md`, `lib/actions.ts`
- 2026-10-01: Floor Map tables are drawn on a Fabric.js canvas; booking there not yet verified → `knowledge/playbooks.md`
- 2026-10-01: slug pages do not reliably set the active restaurant; switching now goes through the chooser and is confirmed by slug → `knowledge/app.md`, `lib/restaurants.ts`
- 2026-10-01: bookings page layout, filter selectors (accessible names differ from text) and search behaviour → `knowledge/app.md`
- 2026-10-01: FAIL "Actual" now shows the check's own message instead of raw matcher output → `lib/checklist.ts`
- 2026-10-01: layout judged at desktop width (responsive wrapping is not a defect); bookings filter ids → `knowledge/playbooks.md`, `knowledge/app.md`
- 2026-10-01: knowledge is ticket-free; pages and per-plan access come from `npm run crawl`; pricing entitlements recorded → `knowledge/sitemap.md`, `knowledge/plans.md`
- 2026-10-02: hosted dev envs with a Stripe test key may take the test-data success card via `fillStripeCard` → `knowledge/playbooks.md`, `CLAUDE.md`
- 2026-10-02: billing wizard steps, discount-code field, T&C modal, checkout rate limit → `knowledge/app.md`; split Stripe card fields → `lib/actions.ts`
