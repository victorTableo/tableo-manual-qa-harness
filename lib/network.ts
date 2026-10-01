import { writeFileSync } from 'node:fs';
import type { Page, Response } from '@playwright/test';
import { artifactPath, redactValue, relativeToRoot } from './report.ts';

/**
 * Records page responses for requirements about what the browser receives.
 * Start before navigating. Headers and cookies are never stored.
 *
 *   const net = recordNetwork(page, { urlPattern: '/api/reports', captureBodies: true });
 *   await page.goto('/reports');
 *   const leaked = await net.bodiesContaining(['secret value']);   // [] = nothing leaked
 *   const file = await net.save('reports');
 */

const RECORDED_TYPES = new Set(['document', 'xhr', 'fetch']);
const TEXT = /^(application\/(json|.*\+json|xml|javascript)|text\/)/i;
const MAX_BODY = 256_000;

export interface CapturedResponse {
  method: string;
  url: string;
  status: number;
  contentType: string;
  body?: string;
}

export class NetworkRecorder {
  readonly responses: CapturedResponse[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly options: { urlPattern?: string | RegExp; captureBodies?: boolean };

  constructor(page: Page, options: { urlPattern?: string | RegExp; captureBodies?: boolean } = {}) {
    this.options = options;
    page.on('response', (response) => {
      const request = response.request();
      if (!RECORDED_TYPES.has(request.resourceType()) || !this.matches(request.url())) return;
      const reading = this.record(response).finally(() => this.pending.delete(reading));
      this.pending.add(reading);
    });
  }

  private matches(url: string): boolean {
    const pattern = this.options.urlPattern;
    return !pattern || (pattern instanceof RegExp ? pattern.test(url) : url.includes(pattern));
  }

  private async record(response: Response): Promise<void> {
    const entry: CapturedResponse = {
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
    };
    // Stored before the body arrives, so find() sees it immediately.
    this.responses.push(entry);
    if (this.options.captureBodies && TEXT.test(entry.contentType)) {
      entry.body = (await response.text().catch(() => undefined))?.slice(0, MAX_BODY);
    }
  }

  find(filter: { status?: number; urlContains?: string; method?: string } = {}): CapturedResponse[] {
    return this.responses.filter(
      (r) =>
        (filter.status === undefined || r.status === filter.status) &&
        (!filter.urlContains || r.url.includes(filter.urlContains)) &&
        (!filter.method || r.method === filter.method.toUpperCase()),
    );
  }

  /** Waits for bodies still loading. Checking earlier could miss a leak. */
  async settled(timeoutMs = 10_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Network bodies still loading after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled([...this.pending]), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The given values that appear in any captured body. */
  async bodiesContaining(values: string[]): Promise<string[]> {
    await this.settled();
    return values.filter((value) => this.responses.some((r) => r.body?.includes(value)));
  }

  /** Writes a redacted JSON dump to the run folder. Returns its path. */
  async save(name: string): Promise<string> {
    await this.settled();
    const target = artifactPath('network', `${name.replace(/[^a-zA-Z0-9-]+/g, '-')}.json`);
    writeFileSync(target, `${JSON.stringify(redactValue(this.responses), null, 2)}\n`);
    return relativeToRoot(target);
  }
}

export function recordNetwork(page: Page, options: { urlPattern?: string | RegExp; captureBodies?: boolean } = {}): NetworkRecorder {
  return new NetworkRecorder(page, options);
}
