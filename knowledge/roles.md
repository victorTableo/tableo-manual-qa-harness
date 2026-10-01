# Roles and plans

| App role | Harness role |
| --- | --- |
| Administrator | `restaurant_admin` |
| Manager | `manager` |
| Booker | `booker` |
| Read Only | `readonly` |
| (environment super admin) | `super_admin` |

- Plans on tableo.com/pricing: Freemium, Organise, Grow, Expand. Legacy plans (Gold, Silver,
  Bronze, Lite, ...) are still in use during migration and are tested like any other
  (QA engineer, 2026-10-01). Plan = the app label lower-cased.
- Which restaurant gives the devrms login which role: run `npm run memberships -- --env=devrms`
  (cached in `.auth/`, never recorded here because it changes).
