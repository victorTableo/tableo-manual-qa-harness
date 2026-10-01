import type { Page } from '@playwright/test';

/**
 * A compact map of the page in front of you: headings, text under the H1, tabs,
 * table headers, and visible controls with a selector hint and their row (y).
 * Used by `npm run probe` (printed) and `npm run crawl` (kept in knowledge/sitemap).
 * Read-only: it only reads the DOM.
 */

export interface Control {
  /** Row: vertical centre in px. */
  y: number;
  tag: string;
  type?: string;
  /** Visible text, placeholder, or label; never a typed value. */
  label: string;
  /** The current value of a field (printed by probe; never stored in the sitemap). */
  value?: string;
  selector: string;
  /** Inside a data table (a row of records), so not part of the page's layout. */
  inTable: boolean;
}

export interface PageMap {
  title: string;
  h1: string;
  headings: string[];
  under: string;
  tabs: Array<{ label: string; target: string }>;
  tables: string[][];
  controls: Control[];
  /** Marketplace cards with an add-on toggle: name and what the card says (included, price, requires). */
  addons: Array<{ name: string; state: string }>;
  /** The app's plan wall text, when the page shows one. */
  wall: string | null;
}

export async function mapPage(page: Page, options: { all?: boolean; scope?: string } = {}): Promise<PageMap> {
  return page.evaluate(({ all, scope }) => {
    const root = (scope && document.querySelector(scope)) || document.querySelector('.content-wrapper') || document.body;
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const y = (e: Element) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2);
    const clean = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const cssId = (id: string) => (/^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${id}"]`);
    const h1 = [...root.querySelectorAll('h1')].find(visible);
    const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5')].filter(visible).slice(0, 12).map((h) => `${h.tagName} "${clean(h.textContent)}"`);
    const labelFor = (el: HTMLInputElement) => {
      const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      return clean(byFor?.textContent || el.closest('label')?.textContent || el.getAttribute('aria-label') || el.placeholder || '');
    };
    const controls = [...root.querySelectorAll('input:not([type=hidden]), select, textarea, button, a.btn, [role=button]')]
      .filter(visible)
      .filter((e) => all || e.getBoundingClientRect().top < window.innerHeight)
      .slice(0, 60)
      .map((e) => {
        const el = e as HTMLInputElement;
        const tag = el.tagName.toLowerCase();
        const field = ['input', 'select', 'textarea'].includes(tag);
        const text = field ? labelFor(el) : clean(el.innerText || el.getAttribute('aria-label') || el.title);
        const selector = el.id ? cssId(el.id) : el.name ? `${tag}[name="${el.name}"]` : `${tag}:has-text("${clean(el.innerText).slice(0, 25)}")`;
        return {
          y: y(e),
          tag,
          ...(el.type && tag !== 'a' ? { type: el.type } : {}),
          label: text,
          ...(field && el.value ? { value: clean(el.value) } : {}),
          selector,
          inTable: Boolean(e.closest('table')),
        };
      });
    const tabs = [...root.querySelectorAll('[role=tab], .nav-tabs a, [data-bs-toggle=tab], [data-toggle=tab]')]
      .filter(visible)
      .map((t) => ({ label: clean((t as HTMLElement).innerText), target: t.getAttribute('href') || t.getAttribute('data-bs-target') || t.getAttribute('aria-controls') || '' }))
      .filter((t, i, list) => t.label && list.findIndex((o) => o.label === t.label) === i);
    const tables = [...root.querySelectorAll('table')]
      .filter(visible)
      .slice(0, 4)
      .map((t) => [...t.querySelectorAll('thead th, tr:first-child th')].map((th) => clean(th.textContent)).filter(Boolean));
    const addons = [...root.querySelectorAll('input[id^="addon_"]')].map((input) => {
      let card: Element = input;
      for (let i = 0; i < 6 && card.parentElement && !card.querySelector('h1,h2,h3,h4,h5,h6'); i += 1) card = card.parentElement;
      const name = clean(card.querySelector('h1,h2,h3,h4,h5,h6')?.textContent) || input.id;
      const body = (card as HTMLElement).innerText ?? '';
      const toggle = input as HTMLInputElement;
      const state = [
        /Included in your plan/i.test(body) ? 'included in plan' : '',
        body.match(/Requires \w+/i)?.[0] ?? '',
        body.match(/[£€$]\s?\d+(?:[.,]\d{2})?(?:\s*\/\s*\w+)?/)?.[0] ?? '',
        toggle.disabled ? 'toggle disabled' : toggle.checked ? 'on' : 'off',
      ].filter(Boolean).join(', ');
      return { name: `${name} (${input.id})`, state };
    });
    // Visible text between the H1 and the first form control or table, outside buttons and links.
    let under = '';
    const first = root.querySelector('input:not([type=hidden]), select, textarea, table');
    if (h1 && first) {
      const top = h1.getBoundingClientRect().bottom;
      const bottom = first.getBoundingClientRect().top;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && under.length < 200; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || !node.textContent?.trim() || parent.closest('button, a, label, script, style') || !visible(parent)) continue;
        const r = parent.getBoundingClientRect();
        if (r.top >= top - 1 && r.bottom <= bottom + 1) under += ` ${node.textContent.trim()}`;
      }
    }
    const bodyText = document.body.innerText ?? '';
    const wall = /Upgrade Required/i.test(bodyText) ? 'Upgrade Required' : /does not have permission/i.test(bodyText) ? 'no permission' : null;
    return { title: document.title, h1: clean(h1?.textContent), headings, under: clean(under).slice(0, 200), tabs, tables, controls, addons, wall };
  }, { all: Boolean(options.all), scope: options.scope ?? '' });
}

/** Probe's one-screen print-out. */
export function formatPageMap(map: PageMap): string[] {
  const lines = [`Headings: ${map.headings.join(' | ') || 'none'}`];
  if (map.under) lines.push(`Text under H1: "${map.under}"`);
  if (map.wall) lines.push(`Wall: ${map.wall}`);
  if (map.tabs.length) lines.push(`Tabs: ${map.tabs.map((t) => `${t.label}${t.target ? ` (${t.target})` : ''}`).join(' | ')}`);
  for (const headers of map.tables) if (headers.length) lines.push(`Table: ${headers.join(' | ')}`);
  if (map.addons.length) lines.push(`Add-ons: ${map.addons.map((a) => `${a.name}: ${a.state}`).join(' | ')}`);
  lines.push('Controls (row y → selector):');
  for (const c of map.controls) {
    lines.push(`  y=${c.y} ${c.tag}${c.type ? `[${c.type}]` : ''} "${c.label}"${c.value ? ` = "${c.value}"` : ''} → ${c.selector}${c.inTable ? ' (in table)' : ''}`);
  }
  return lines;
}
