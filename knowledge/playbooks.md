# Playbooks: how to do things in Tableo

Recipes for actions a ticket may need. Each says when it was verified; keep them current (Learn
step in `/qa`). Where a page is and what is on it: `sitemap.md`. Use test data from `config/test-data.json` via `config/test-data.ts` (`guestName()`,
`qaEmail(tag?)`, `qaPhone(i)`, `randomPhone()`, `stripeCard(kind)`, `qaNote(ticket)`), record every
change with `ctx.change(what, undo)`, and prefer helpers in `lib/actions.ts` where they exist.

## Judging layout tickets (2026-10-01)

Judge layout at the desktop viewport (1920×1080). Controls wrapping onto more rows on narrower screens is
responsive design, not a defect; flag only overlap, cut-off or unusable controls. Tablet and mobile only when
the ticket demands it (it names mobile, tablet, responsive, a device or a width): `run.check(…, { role, device:
'mobile' })` uses a real device preset (iPhone 13 390×664, iPad Mini 768×1024, landscape 1024×768) and reuses
the desktop sign-in. `npm run probe -- --device=mobile …` shows a page at that size. Measure rows with `boundingBox()` centres (same row: within ~10 px), find selectors with
`npm run probe`. A layout/UI change needs one restaurant and one role, not every plan.

## Test data rules

- Names, emails, phones and cards live in `config/test-data.json`. Emails always read
  glory+<…test…>@tableo.com (or a listed tag such as "guest"). `QA_PHONE` / `QA_EMAIL` in `.env`,
  or a number named in the request, override the defaults and are used alone.
- Notes / free text: `qaNote(ticket)` (e.g. "Testing") so records trace back.
- Phone fields are an international widget: type key by key (`fillPhone`), never `fill`, or it
  keeps Belgium and the app says "The phone number format is invalid."

## Place a booking: Booking form (verified 2026-10-01)

1. `bookings/create`. Date defaults to today. `#booking_time` (select a value, e.g. 20:00), `#duration`.
2. Adults are buttons 1-5 / "Other" (2 is preselected).
3. **Select a table**: `button[id^="table-"]:not(#table-selection-cta):visible` (first free one).
   Without it: "No tables selected. Please select at least one table for the booking."
4. Guest: `fillPhone(#mobile_number)`, `#patron_name`, `#email`; `#private_comment` = `qaNote()`.
5. `#submit` (Save) → `POST /admin/bookings/store` → redirect to the Diary for that date.
6. Reference: `newestBookingRef(page, slug, guestName)` (bookings list, newest first).

Walk-in: `bookings/create?walkin=1`, same form without a date (seated now). Not yet saved in a test.

## Place a booking: Diary (verified 2026-10-01)

FullCalendar resource timeline. Lanes: `.fc-timeline-lane[data-resource-id="<tableId>"]`; time slots:
`.fc-timeline-slot[data-date*="T20:00"]`. Click at (slot x, lane y) → a `.modal.show` dialog with the
booking form, table and time preset. Fill guest fields (same names as the form) and Save.

## Place a booking: public widget (verified 2026-10-01)

1. Signed out (`createContext`), `/widget/<slug>`.
2. Step 1: `#no_of_adults`, `#no_of_children`; date buttons ("2 Fri"; disabled days are not
   clickable); then a time button per area ("Indoor Lunch · Dinner" → 12:00, 18:00…). `#step1-next-btn`
   stays disabled until a time is chosen (hint "To continue, please select: Time").
3. Step 2: `#name`, `#email`, `#mobile_number` (fillPhone), optional occasion / birthday / dietary
   sections, required terms checkbox; `#step2-finish-btn` ("Finish").
4. Success page `/widget/<slug>/bookings/success/<REF>`. The booking arrives **pending** (Accept / Reject in admin).

## Place a booking: Floor Map (not verified)

`restaurant-floor-map/floor-map-ui`: area tabs are `div.selectedArea` badges; tables are drawn on a
Fabric.js canvas (not DOM elements) and the canvas instance is not exposed. To book: pick the area,
take a screenshot, click the table by position, then expect the same booking dialog. Verify and update
this entry the first time a ticket needs it.

## Cancel / clean up a booking (verified)

`cancelBooking(page, slug, ref)`: confirmed bookings → "Cancel"; pending (widget) bookings → "Reject";
both confirm with "Yes I'm sure!" (`POST .../bookings/cancel/<REF>` or `.../bookings/reject?<REF>`).
Status afterwards: CANCELLED / REJECTED. Register it as the undo of every booking a check creates.

## Switch an add-on on or off (verified 2026-10-01, Email Branding)

`setAddon(page, slug, 'Email Branding', true)` returns the previous state; undo with
`setAddon(page, slug, name, previous)`. On: `POST restaurant-addons/store/<id>` and a modal
"Added to your profile". Off: modal "Are you sure … Cancel / Disable" → Disable.
**Paid add-ons (e.g. £9.99/month) are purchases**: only when the ticket needs it and the QA engineer
approved it for this run.

## Change a setting (located, not yet changed in a test)

- Service hours: `services-hub/regular-hours` ("Add service", "Duplicate", "Save Changes"). Seasonal
  hours and events next to it. Ben's Bistro shows "No service hours configured for this day" in the Diary.
- Booking settings, crowd control, closed days, messaging, payments: Account Settings `edit`, tabs
  `#booking-settings`, `#crowd-control`, `#closed-days`, `#messaging-settings`, `#payment-provider`.
- Widget appearance: `widget-preview`; widget form options under Account Settings → Booking Settings.

Before saving any setting: read and keep the current values, change only what the ticket needs,
and register an undo that restores them.

## Change plan (located, not yet changed in a test)

`billing-subscription-switch-plan` lists the plans ("Basic Business Reports" on Organise, "Detailed
Business Intelligence Reports" on Grow, add-on fees). A plan change is a purchase: it needs the QA
engineer's approval in the run plan. If a card form appears, `fillStripeCard()` only fills Stripe's
test card on a Stripe test-mode page (`pk_test_`). Claude does not type card numbers on a hosted environment such as devrms.tableo.com: that step is left to the QA
engineer (run with `QA_WATCH=1`) unless a test card is already saved on the restaurant.

## Onboarding a new restaurant (not automatable)

Onboarding sends a one-time code by email/SMS, which the harness cannot read or generate (it is
not a TOTP). Onboarding requirements are `run.manual(...)` with that reason. Never guess codes.
