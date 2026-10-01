# Plans: what each one should get

From the public pricing page https://tableo.com/pricing-malta (read 2026-10-01). It shows what Tableo
**promises**, which helps you find where a plan-gated feature lives. It is not evidence: the ticket says what
to test, and the app shows what happens. What each plan actually sees is in `sitemap.md` (crawled), where
differences from this table are listed at the top.

- Current plans, cheapest first: **Freemium, Organise, Grow, Expand**. Legacy plans (Gold, Silver, Bronze,
  Lite…) are still in use and tested as the app shows them; they have no column here.
- `npm run crawl` reads the table below. A ✗ (or blank, —) means not included; anything else (✓, a
  number, "3 users") means included. The **Admin path** column links a feature to its page so the crawl
  can compare. Fill it only from a page you have seen, and leave it empty when unsure.

| Feature | Freemium | Organise | Grow | Expand | Admin path (to confirm) |
| --- | --- | --- | --- | --- | --- |
| Real-time reservations | ✓ | ✓ | ✓ | ✓ | `bookings` |
| Table management | ✓ | ✓ | ✓ | ✓ | `tables` |
| Interactive floor map | ✓ | ✓ | ✓ | ✓ | `restaurant-floor-map/floor-map-ui` |
| Special service hours | ✓ | ✓ | ✓ | ✓ | `services-hub/seasonal-hours` |
| Complete booking history | ✓ | ✓ | ✓ | ✓ | |
| Print-out of booking list | ✓ | ✓ | ✓ | ✓ | |
| Crowd control (cap online bookings by covers/minute) | ✓ | ✓ | ✓ | ✓ | |
| Custom-naming dining areas | ✓ | ✓ | ✓ | ✓ | |
| Waiting list | ✓ | ✓ | ✓ | ✓ | |
| Users | 1 | 3 | 5 | Unlimited | `managers` |
| Bookings per month | 100 covers | Unlimited | Unlimited | Unlimited | |
| Facebook & Instagram connection | ✓ | ✓ | ✓ | ✓ | |
| Reserve with Google (free up to 100 covers) | ✗ | ✓ | ✓ | ✓ | |
| Customisable website booking form | ✗ | ✓ | ✓ | ✓ | |
| AIMA on Facebook & Instagram (1 month free) | ✗ | ✓ | ✓ | ✓ | |
| Email notifications | ✓ | ✓ | ✓ | ✓ | |
| Booking reminders | ✓ | ✓ | ✓ | ✓ | |
| Tableo guest feedback & reviews | ✓ | ✓ | ✓ | ✓ | `reviews` |
| Blacklist management | ✓ | ✓ | ✓ | ✓ | |
| Custom email branding | ✗ | ✓ | ✓ | ✓ | |
| Exportable guest database for marketing | ✗ | ✓ | ✓ | ✓ | |
| Guest notifications (SMS & WhatsApp) | ✗ | ✓ | ✓ | ✓ | |
| Guest reviews on Google, Facebook & TripAdvisor | ✗ | ✓ | ✓ | ✓ | |
| Automatic reconfirmation of bookings | ✗ | ✓ | ✓ | ✓ | |
| Marketing automations | ✗ | 1 | 2 | Unlimited | |
| Email marketing campaigns | ✗ | ✓ | ✓ | ✓ | |
| Email allowance per month | ✗ | 1,000 + top-ups | 10,000 + top-ups | 10,000 + top-ups | |
| Sell products & menus online | ✗ | ✓ | ✓ | ✓ | `services-hub/products` |
| Take pre-payments & deposits (1% + Stripe fees) | ✗ | ✓ | ✓ | ✓ | |
| Card verification & no-show fees | ✗ | ✗ | ✓ | ✓ | |
| Sell gift vouchers | ✗ | ✗ | ✓ | ✓ | |
| Event management | ✗ | ✗ | ✓ | ✓ | `services-hub/events` |
| Basic business reports | ✗ | ✓ | ✓ | ✓ | `reports/bookings-report` |
| Concierge / affiliate service (tracked booking links) | ✗ | ✗ | ✓ | ✓ | `reports/concierge-bookings-report` |
| Enhanced business reports | ✗ | ✗ | ✓ | ✓ | |
| Restaurant chain cross-selling | ✗ | ✗ | ✗ | ✓ | |
| API access | ✗ | ✗ | ✗ | ✓ | |
| Setup and staff training | ✗ | ✗ | ✗ | ✓ | |
| Dedicated account manager | ✗ | ✗ | ✗ | ✓ | |

Support: Freemium email & live chat; Organise and Grow add phone; Expand adds proactive calls.
Paid extras on the pricing page: email marketing top-ups (€19.99/month per 10,000 emails, "CRM Pro"), and
carrier fees for SMS & WhatsApp. The in-app Marketplace sells further add-ons (e.g. the reports add-ons at
9.99/month); `sitemap.md` lists what each plan's Marketplace shows. Buying one needs the QA engineer's yes.
