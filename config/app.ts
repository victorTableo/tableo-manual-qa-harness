import type { Role } from '../lib/accounts.ts';

/**
 * Where things are in Tableo: the one file to edit when the app's UI changes.
 * Every environment runs the same app, so there is one profile.
 *
 * Values were observed in the UI (knowledge/app.md); never fill one in with a
 * guess. tests/selfcheck.spec.ts serves a fixture with the same paths and markup:
 * mirror any change there and run `npm run selfcheck`.
 */
export const APP = {
  login: {
    path: '/login',
    username: '#email',
    password: '#password',
    submit: 'form[action$="/login"] button[type="submit"]',
    /** Any page under this path means the session is signed in. */
    signedInPath: '/admin',
    /** Opened to check that a cached session is still signed in. */
    probePath: '/admin/dashboard',
  },

  /** Google Authenticator challenge, shown after the password is accepted. */
  mfa: {
    path: '/two-factor-challenge',
    // A hidden recovery-code form and a "Try another way" form (which sends an
    // email) share the page, so everything is scoped to the form with the code input.
    form: 'form[action$="/two-factor-challenge"]:has(input[name="code"])',
    code: 'input[name="code"]',
    submit: 'button[type="submit"]',
    trustDevice: 'input[name="remember_device"]',
    rejectedText: 'The provided two factor authentication code was invalid.',
  },

  restaurants: {
    /** Lists every restaurant the login administers: "#id | Name (City) | ... | Edit". */
    listPath: '/admin/restaurants',
    /** The "Choose a restaurant" page; lists every restaurant the login can open. */
    chooserPath: '/admin/unset-active-restaurant',
    chooserOption: 'button:has-text("Manage")',
    chooserLabelSuffix: /\s*Manage\s*$/,
    /** Header element naming the active restaurant; the title holds the untruncated name. */
    active: { selector: 'span.restaurant-name-text', attribute: 'title' },
    /** Slug in any restaurant URL, e.g. /admin/restaurants/<slug>/edit. */
    slugInPath: /\/admin\/restaurants\/([^/?#]+)/,
    /** Sidebar links of the active restaurant carry its slug: proof of which restaurant is open. */
    slugLink: (slug: string) => `#sidebar a[href*="/admin/restaurants/${slug}/"]`,
    planPath: (slug: string) => `/admin/restaurants/${encodeURIComponent(slug)}/billing-subscription`,
    /** Rendered empty, then filled by script: wait for text. */
    planName: '#current-plan-name',
    teamPath: (slug: string) => `/admin/restaurants/${encodeURIComponent(slug)}/managers`,
    roleColumn: 'Roles',
    /** Team Management -> Add Member radio labels. */
    roleLabels: {
      Administrator: 'restaurant_admin',
      Manager: 'manager',
      Booker: 'booker',
      'Read Only': 'readonly',
    } satisfies Record<string, Role>,
    howToGrantRole: 'Team Management -> Add Member (or Edit) in that restaurant',
  },

  /** The plans on tableo.com/pricing. Other plans (legacy) still work; these are just shown in coverage. */
  currentPlans: ['freemium', 'organise', 'grow', 'expand'],
} as const;

/** Harness role -> the app's label, for instructions to the QA engineer. */
export function appRoleLabel(role: Role): string {
  const hit = Object.entries(APP.restaurants.roleLabels).find(([, value]) => value === role);
  return hit ? hit[0] : role === 'super_admin' ? 'Super Admin' : role;
}

/** "Read Only Can view..." -> 'readonly'. Longest label first, so a prefix never wins. */
export function roleFromLabel(text: string): Role | undefined {
  const labels = Object.keys(APP.restaurants.roleLabels).sort((a, b) => b.length - a.length);
  const hit = labels.find((label) => text === label || text.toLowerCase().startsWith(`${label.toLowerCase()} `));
  return hit ? APP.restaurants.roleLabels[hit as keyof typeof APP.restaurants.roleLabels] : undefined;
}

/** "grow" -> "Grow". */
export function planLabel(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}
