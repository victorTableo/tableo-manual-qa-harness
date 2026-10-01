# Tableo: verified facts

Behaviour and quirks learned by testing, used for navigation. The ticket always wins over this file; if
the app contradicts an entry, fix the entry. Verified 2026-10-01 unless the entry says otherwise.
Every page's path, controls and selectors, and what each plan sees there: `sitemap.md` (crawled; look a
page up there first). What each plan should get: `plans.md`. How-to recipes: `playbooks.md`.

## Sign-in

- `/login`: `#email`, `#password`, submit inside `form[action$="/login"]`. Signed-out visits to
  `/admin/*` redirect to `/login`.
- A valid password leads to `/two-factor-challenge`; the code form holds `input[name="code"]` and
  `input[name="remember_device"]`. The page also has a "Having trouble? Try another way" form that
  **sends an email**: never click it.
- After sign-in the app shows "Choose a restaurant" at `/admin/dashboard`.

## Restaurants

- Chooser: `/admin/unset-active-restaurant` (profile menu "Switch Restaurant"); one button per
  restaurant, text "<name> Manage"; choosing lands on `/admin/dashboard?<slug>`. Right after a
  restaurant was opened the chooser sometimes renders without buttons; reloading fixes it.
- Active restaurant: `span.restaurant-name-text`; its `title` holds the full name (text truncates).
- `/admin/restaurants`: table "#id | Name (City) | Active | Edit" with slug links; redirects to the
  chooser when no restaurant is active.
- A `/admin/restaurants/<slug>/...` page shows that restaurant (header and sidebar links carry the slug)
  but does **not** reliably make it the session's active restaurant: visiting All Day's bookings page
  did, McDonald's did not (2026-10-01). Pages without a slug (`/admin/dashboard`, `/admin/payments/report`)
  follow the session, so switch through the chooser and confirm by slug (`?<slug>` in the URL or
  sidebar links).
- A restaurant chain ("Glory" on devrms) appears in the chooser but opens no restaurant.

## Navigation (sidebar, `/admin/restaurants/<slug>/...`; full detail per page in `sitemap.md`)

| Area | Path |
| --- | --- |
| New booking / Walk-in | `bookings/create`, `bookings/create?walkin=1` |
| Diary, Floor Map | `bookings/diary`, `restaurant-floor-map/floor-map-ui` |
| Bookings list, one booking | `bookings`, `bookings/show/<REF>` (e.g. `AKJ-XG7`) |
| Guests, Reviews | `patrons`, `reviews` |
| Reports | `reports/bookings-report`, `bookings/calendar`, `reports/revenue-report`, `reports/frequent-patrons-report`, `reports/concierge-bookings-report`, `reports/booking-billing`; Payments: `/admin/payments/report` (no slug) |
| Marketplace | `restaurant-addons` |
| Hours and events | `services-hub/regular-hours`, `services-hub/seasonal-hours`, `services-hub/events`, `services-hub/products` |
| Account Settings | `edit` (tabs: Basic Data, Booking Terms, Closed Days, Messaging Settings, Booking Settings, Crowd Control, Online Payment Settings, Booking Payment Rules, Booking Duration Matrix; links: Locale Settings, Dining Areas, Reserve With Google, Restaurant Chain) |
| Tables, Team, Floor map editor | `tables`, `managers`, `restaurant-floor-map` |
| Billing, plan picker | `billing-subscription`, `billing-subscription-switch-plan` |
| Widget preview, public widget | `widget-preview`; public: `/widget/<slug>` |

## Bookings page (2026-10-01)

- `/admin/restaurants/<slug>/bookings`: H1 "Bookings" with an "Import" button; under it the text
  "Bookings from <date> to <date>"; then `input[name="search"]` on its own row; then a row "Show report
  for:" with the filters "Booking for date", "Select a Date Range", "All channels", "All statuses",
  "All payment statuses" and the `button[type="submit"]` "Search".
- The Search button sits on the filter row at desktop width (1920 px); on narrower screens the row wraps (responsive, expected).
- Filter buttons have stable ids: `#filter-dropdown-filterdateby-trigger`, `#filter-dropdown-channel-trigger`,
  `#filter-dropdown-status-trigger`, `#filter-dropdown-payment-status-trigger` (their accessible names differ
  from their text, so `getByRole('button', { name })` does not match). Booking status buttons:
  `#status-dropdown-button-<REF>`.
- Search: fill `input[name="search"]` and press Search → `?search=<text>`; results are the bookings table rows.

## Plans, roles, reports

- Plan label: `#current-plan-name` on the billing page, rendered empty and filled by script; a
  "Termination" badge sits next to it on cancelled subscriptions.
- Roles: Team Management -> Add Member radios `input[name="roles"]`: Administrator 5, Manager 4,
  Booker 6, Read Only 7. The team list shows them in the "Roles" column with a hidden description.
- Freemium: every report returns HTTP 403 with "Upgrade Required"; sidebar items show a lock;
  Payments Report opens. A Freemium Administrator also gets 403 on `managers/create` ("Your user role
  does not have permission to access this page or perform this function.").
- Marketplace toggles are `input#addon_<id>` (e.g. Email Branding = `addon_31` on Ben's Bistro). On a
  Gold restaurant the BI reports add-on reads "Included in your plan" (toggle disabled).

## Known quirks (seen 2026-10-01, not ticketed)

- Marketplace BI add-on card shows the raw key "market-place.Detailed Business Intelligence Reports".
- Booking duration matrix heading shows the raw key "admin.Set different reservation lengths…".
- Booking change history shows the raw status "booking_created".
- "Pending Payment" banner says the account "will be deactivated in -749.51… days" (negative, unrounded).
