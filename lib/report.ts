import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AccountRef } from './accounts.ts';
import { appRoleLabel, planLabel } from '../config/app.ts';
import { deviceLabel, type Device } from './environments.ts';

/**
 * Run folders, redaction, and the QA report.
 *
 * Each run gets one folder: artifacts/<TICKET>/2026-10-01_10-51AM/ (retests end in
 * _retest), created on first use. report.md is written to paste straight into Linear.
 */

export const ARTIFACTS_ROOT = path.resolve(process.cwd(), 'artifacts');
const KINDS = ['screenshots', 'network', 'downloads'] as const;
type Kind = (typeof KINDS)[number];

let ticket = (process.env.QA_TICKET ?? '').trim();
let label = '';
let current: string | null = null;
const counters: Record<string, number> = {};

/** Next number for a kind of evidence in this run: 1, 2, 3... */
export function nextIndex(kind: Kind): number {
  counters[kind] = (counters[kind] ?? 0) + 1;
  return counters[kind]!;
}

function safeTicket(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'adhoc';
}

/** "2026-10-01_10-51AM" */
function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const hours = date.getHours() % 12 || 12;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(hours)}-${pad(date.getMinutes())}${date.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** "1 Oct 2026, 10:51 AM" */
export function humanTime(date = new Date()): string {
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\bam\b/, 'AM').replace(/\bpm\b/, 'PM');
}

/** Starts a new run for a ticket (optional folder label, e.g. "retest"); its folder is created on first use. */
export function setTicket(value: string, runLabel = ''): void {
  ticket = value;
  label = runLabel;
  current = null;
  for (const key of Object.keys(counters)) delete counters[key];
}

export function currentTicket(): string {
  return safeTicket(ticket || 'adhoc');
}

/** The run folder, created on first call. */
export function runDir(): string {
  if (current) return current;
  const base = path.join(ARTIFACTS_ROOT, currentTicket());
  const name = `${stamp()}${label ? `_${label}` : ''}`;
  let folder = name;
  for (let n = 2; existsSync(path.join(base, folder)); n += 1) folder = `${name}-${n}`;
  current = path.join(base, folder);
  for (const kind of KINDS) mkdirSync(path.join(current, kind), { recursive: true });
  return current;
}

export function artifactPath(kind: Kind, filename: string): string {
  return path.join(runDir(), kind, filename);
}

export function relativeToRoot(target: string): string {
  return path.relative(process.cwd(), target).split(path.sep).join('/');
}

/** The newest finished run of a ticket (one with results.json), or null. */
export function previousRun(forTicket: string, environment?: string): { dir: string; startedAt: string; title?: string; results: RequirementResult[] } | null {
  const base = path.join(ARTIFACTS_ROOT, safeTicket(forTicket));
  if (!existsSync(base)) return null;
  const runs = readdirSync(base)
    .filter((name) => name !== 'latest')
    .map((name) => path.join(base, name, 'results.json'))
    .filter((file) => existsSync(file))
    .filter((file) => !environment || (JSON.parse(readFileSync(file, 'utf8')) as { meta: ReportMeta }).meta.environment === environment)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!runs.length) return null;
  const data = JSON.parse(readFileSync(runs[0]!, 'utf8')) as { meta: ReportMeta; results: RequirementResult[] };
  const startedAt = data.meta.startedAt ?? statSync(runs[0]!).mtime.toISOString();
  return { dir: path.dirname(runs[0]!), startedAt, title: data.meta.title, results: data.results };
}

const SECRETS = new Set<string>();

/**
 * Register a live secret so it can never reach an artifact or a log line.
 * Values that read like ordinary prose (letters only, under 16 characters) are
 * not registered: masking such a word wherever it appears in ticket or page text
 * would point straight at the credential. The harness never writes credentials;
 * this is the safety net for tokens, emails and seeds.
 */
export function registerSecret(value: string | undefined): void {
  const secret = value?.trim() ?? '';
  if (secret.length >= 4 && (/[^A-Za-z]/.test(secret) || secret.length >= 16)) SECRETS.add(secret);
}

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  // Real Basic/Bearer tokens contain a digit or "="; "Basic Business Reports" must survive.
  [/\b(bearer|basic)\s+(?=[A-Za-z._~+/-]*[0-9=])[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [
    /(\\*"?(?:access_?token|refresh_?token|id_?token|token|password|passwd|secret|authorization|cookie|session_?id|api_?key)\\*"?\s*[:=]\s*\\*")([^"\\]{1,})(\\?")/gi,
    '$1***$3',
  ],
  [/\b(set-cookie|cookie)\s*:\s*[^\n]+/gi, '$1: ***'],
  [/([?&](?:access_?token|refresh_?token|id_?token|token|password|secret|api_?key|auth)=)([^&\s"'#]+)/gi, '$1***'],
];

export function redact(input: string): string {
  let output = input;
  for (const secret of SECRETS) output = output.split(secret).join('***');
  for (const [pattern, replacement] of TOKEN_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

export function redactValue<T>(value: T): T {
  const text = redact(JSON.stringify(value ?? null));
  try {
    return JSON.parse(text) as T;
  } catch {
    return { redactedText: text } as unknown as T;
  }
}

/** Console output is redacted too, so a stray log can never leak a password. */
export function safeLog(message: string): void {
  console.log(redact(message));
}

export type RequirementStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'ERROR';

export interface RequirementResult {
  title: string;
  status: RequirementStatus;
  expected?: string;
  actual?: string;
  /** Why it is not a PASS. */
  reason?: string;
  /** What a person has to do (configure, test by hand, look into). */
  action?: string;
  evidence: string[];
  account?: AccountRef;
  /** Set only when the check ran at another size than desktop. */
  device?: Device;
  durationMs?: number;
  /** Not in the ticket: a case the agent added, and why it was worth checking. */
  extra?: { why: string };
  /** Not re-run in a retest: the time of the run it passed in. */
  carriedFrom?: string;
}

/** Data the run created or changed in the app, and whether it was put back. */
export interface ChangeRecord {
  what: string;
  reverted: boolean | null;
  detail?: string;
}

export interface ReportMeta {
  environment: string;
  baseUrl: string;
  title?: string;
  /** The ticket text as given; kept in results.json, not in report.md (Linear already has it). */
  source?: string;
  startedAt: string;
  retest?: { mode: 'failed' | 'full'; previousStartedAt: string | null };
  changes: ChangeRecord[];
  noticed: Array<{ text: string; evidence?: string }>;
  /** What the run taught the harness, and the repo file updated. Kept out of report.md. */
  learned: Array<{ text: string; file: string }>;
}

const ICON: Record<RequirementStatus, string> = { PASS: '✅', FAIL: '❌', BLOCKED: '⛔', ERROR: '⚠️' };

function count(results: RequirementResult[], status: RequirementStatus): number {
  return results.filter((r) => r.status === status).length;
}

export function formatSummary(results: RequirementResult[]): string {
  return `PASS: ${count(results, 'PASS')}  FAIL: ${count(results, 'FAIL')}  BLOCKED: ${count(results, 'BLOCKED')}  ERROR: ${count(results, 'ERROR')}`;
}

/** The first sentence only; the full text is in run-notes.md. */
function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : text).trim();
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function totals(results: RequirementResult[]): string {
  return `✅ ${count(results, 'PASS')} passed · ❌ ${count(results, 'FAIL')} failed · ⛔ ${count(results, 'BLOCKED')} not tested · ⚠️ ${plural(count(results, 'ERROR'), 'error')}`;
}

/** "Administrator @ McDonald's (Freemium)" */
function who(account: AccountRef | undefined): string {
  if (!account) return '';
  const role = appRoleLabel(account.role as never);
  return account.restaurant ? `${role} @ ${account.restaurant}${account.plan ? ` (${planLabel(account.plan)})` : ''}` : role;
}

/** Screenshot names; a carried-over pass points into the earlier run's folder. */
function file(evidence: string[], carried = false): string {
  return evidence.map((e) => `\`${carried ? `${path.basename(path.dirname(path.dirname(e)))}/` : ''}${path.basename(e)}\``).join(', ');
}

/**
 * One requirement that did not pass: title, Expected, Actual (FAIL) or Why + Action (ERROR),
 * screenshot. "Who" is shown only when the run used more than one identity.
 */
function detailed(result: RequirementResult, index: number, showWho = true): string[] {
  const lines = [`**${index}. ${result.title}**${showWho && result.account?.restaurant ? ` · ${who(result.account)}` : ''}${onDevice(result)}`];
  if (result.extra) lines.push(`- Why checked: ${result.extra.why}`);
  if (result.expected) lines.push(`- Expected: ${result.expected}`);
  if (result.actual) lines.push(`- Actual: ${result.actual}`);
  if (result.status !== 'FAIL' && result.reason) lines.push(`- Why: ${result.reason}`);
  if (result.action) lines.push(`- Action: ${result.action}`);
  if (result.evidence.length) lines.push(`- 📎 ${file(result.evidence)}`);
  return [...lines, ''];
}

/** " · Mobile (390×664)" for a check at another size than desktop, else nothing. */
function onDevice(result: RequirementResult): string {
  return result.device ? ` · ${deviceLabel(result.device)}` : '';
}

function passed(result: RequirementResult): string {
  const carried = result.carriedFrom ? ` _(passed ${result.carriedFrom}, not re-run)_` : '';
  const evidence = result.evidence.length ? ` · ${file(result.evidence, Boolean(result.carriedFrom))}` : '';
  const actual = result.actual && !result.carriedFrom ? ` — ${result.actual}` : '';
  return `- ${result.title}${onDevice(result)}${actual}${carried}${evidence}`;
}

export function buildReport(results: RequirementResult[], meta: ReportMeta, previous: RequirementResult[] | null): string {
  const ticketResults = results.filter((r) => !r.extra);
  const extras = results.filter((r) => r.extra);
  const lines: string[] = [
    `## QA: ${currentTicket()}${meta.title ? ` — ${meta.title}` : ''}`,
    '',
    `**Result:** ${totals(ticketResults)}`,
    `**Environment:** ${meta.environment} (${meta.baseUrl}) · ${humanTime(new Date(meta.startedAt))}`,
  ];
  const testedAs = [...new Set(ticketResults.filter((r) => r.status !== 'BLOCKED' && r.account?.restaurant).map((r) => who(r.account)))];
  if (testedAs.length) lines.push(`**Tested as:** ${testedAs.join('; ')}`);
  const showWho = testedAs.length > 1;
  if (meta.retest) {
    const carried = ticketResults.filter((r) => r.carriedFrom).length;
    lines.push(
      `**Retest** of the ${meta.retest.previousStartedAt ? humanTime(new Date(meta.retest.previousStartedAt)) : 'previous'} run: ` +
        (meta.retest.mode === 'failed' ? `everything that had not passed was re-run; ${plural(carried, 'earlier pass', 'earlier passes')} carried over.` : 'everything re-run.'),
    );
  }
  lines.push('');

  if (previous) {
    // Earlier results were stored redacted; compare like with like.
    const before = new Map(previous.map((r) => [redact(r.title), r.status]));
    const changed = ticketResults.filter((r) => before.has(redact(r.title)) && before.get(redact(r.title)) !== r.status);
    const added = ticketResults.filter((r) => !before.has(redact(r.title)));
    lines.push('### 🔁 Changes since the previous run', '');
    for (const r of changed) lines.push(`- ${ICON[before.get(redact(r.title))!]} → ${ICON[r.status]} ${r.title}`);
    for (const r of added) lines.push(`- 🆕 ${ICON[r.status]} ${r.title}`);
    if (!changed.length && !added.length) lines.push('- No result changed.');
    lines.push('');
  }

  let n = 0;
  const failed = ticketResults.filter((r) => r.status === 'FAIL');
  if (failed.length) {
    lines.push(`### ❌ Failed (${failed.length})`, '');
    for (const r of failed) lines.push(...detailed(r, ++n, showWho));
  }
  const errors = ticketResults.filter((r) => r.status === 'ERROR');
  if (errors.length) {
    lines.push(`### ⚠️ Automation errors (${errors.length})`, '');
    for (const r of errors) lines.push(...detailed(r, ++n, showWho));
  }
  const blocked = ticketResults.filter((r) => r.status === 'BLOCKED');
  if (blocked.length) {
    lines.push(`### ⛔ Not tested (${blocked.length})`, '');
    const groups = new Map<string, RequirementResult[]>();
    for (const r of blocked) groups.set(r.action ?? 'No action given', [...(groups.get(r.action ?? 'No action given') ?? []), r]);
    for (const [action, group] of groups) {
      const reasons = [...new Set(group.map((r) => firstSentence(r.reason ?? '')))];
      lines.push(`**To do:** ${action}`);
      if (reasons.length === 1 && reasons[0]) lines.push(`_Why:_ ${reasons[0]}`);
      for (const r of group) lines.push(`- ${r.title}${reasons.length > 1 && r.reason ? ` — ${firstSentence(r.reason)}` : ''}`);
      lines.push('');
    }
  }
  const passes = ticketResults.filter((r) => r.status === 'PASS');
  if (passes.length) {
    lines.push(`### ✅ Passed (${passes.length})`, '', ...passes.map(passed), '');
  }

  if (extras.length || meta.noticed.length) {
    lines.push('### 💡 Also checked (not in the ticket)', '');
    for (const r of extras) {
      if (r.status === 'PASS') lines.push(`- ✅ **${r.title}** — ${r.extra!.why}${r.actual ? `. ${r.actual}` : ''}${r.evidence.length ? ` · ${file(r.evidence)}` : ''}`);
      else lines.push(...detailed(r, ++n).map((line, i) => (i === 0 ? `${ICON[r.status]} ${line}` : line)));
    }
    for (const item of meta.noticed) lines.push(`- 👀 Noticed: ${item.text}${item.evidence ? ` · \`${path.basename(item.evidence)}\`` : ''}`);
    lines.push('');
  }

  return redact(lines.join('\n').trimEnd());
}

/** Internal notes for the run (never pasted into Linear): changes made, lessons, where evidence is. */
export function buildRunNotes(results: RequirementResult[], meta: ReportMeta): string {
  const lines = [`# Run notes: ${currentTicket()} — ${humanTime(new Date(meta.startedAt))}`, ''];
  lines.push(`- Environment: ${meta.environment} (${meta.baseUrl})`, `- Evidence: ${relativeToRoot(runDir())}`);
  if (meta.retest) lines.push(`- Retest (${meta.retest.mode}) of ${meta.retest.previousStartedAt ? humanTime(new Date(meta.retest.previousStartedAt)) : 'no earlier run'}`);
  lines.push(`- ${formatSummary(results.filter((r) => !r.extra))}`, '');
  lines.push('## Changes made in the app', '');
  if (!meta.changes.length) lines.push('- None.');
  for (const c of meta.changes) {
    const state = c.reverted === true ? 'reverted ✔' : c.reverted === false ? 'NOT reverted ✘' : 'left in place';
    lines.push(`- ${c.what} — ${state}${c.detail ? ` (${c.detail})` : ''}`);
  }
  lines.push('', '## Learned this run', '');
  if (!meta.learned.length) lines.push('- Nothing new.');
  for (const l of meta.learned) lines.push(`- ${l.text} → \`${l.file}\``);
  const blocked = results.filter((r) => r.status !== 'PASS' && r.reason);
  if (blocked.length) {
    lines.push('', '## Not passed: full reasons', '');
    for (const r of blocked) lines.push(`- **${r.title}**: ${r.reason ?? ''}${r.action ? ` Action: ${r.action}` : ''}`);
  }
  const slow = results.filter((r) => (r.durationMs ?? 0) > 60_000);
  if (slow.length) lines.push('', '## Slow checks (> 60s)', '', ...slow.map((r) => `- ${r.title}: ${Math.round(r.durationMs! / 1000)}s`));
  return redact(lines.join('\n'));
}

/** knowledge/CHANGELOG.md (QA_CHANGELOG points elsewhere, e.g. in the self-check). */
function changelogPath(): string {
  return path.resolve(process.cwd(), process.env.QA_CHANGELOG || path.join('knowledge', 'CHANGELOG.md'));
}

/** Writes report.md (for Linear), run-notes.md and results.json; logs lessons to knowledge/CHANGELOG.md. */
export function writeReport(results: RequirementResult[], meta: ReportMeta, previous: RequirementResult[] | null = null): string {
  const target = path.join(runDir(), 'report.md');
  writeFileSync(target, `${buildReport(results, meta, previous)}\n`, 'utf8');
  writeFileSync(path.join(runDir(), 'run-notes.md'), `${buildRunNotes(results, meta)}\n`, 'utf8');
  if (meta.learned.length) {
    const CHANGELOG = changelogPath();
    if (!existsSync(CHANGELOG)) writeFileSync(CHANGELOG, '# What the agent learned\n\nOne line per lesson, newest last: date, lesson → file updated.\n\n', 'utf8');
    const day = meta.startedAt.slice(0, 10);
    // Lessons describe the app, not the ticket: the knowledge stays reusable; artifacts/ records what was tested.
    appendFileSync(CHANGELOG, meta.learned.map((l) => `- ${day}: ${redact(l.text)} → \`${l.file}\`\n`).join(''), 'utf8');
  }
  writeFileSync(path.join(runDir(), 'results.json'), `${JSON.stringify(redactValue({ meta, results }), null, 2)}\n`, 'utf8');
  return target;
}
