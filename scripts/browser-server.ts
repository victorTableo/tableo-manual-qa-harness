import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { watching } from '../lib/environments.ts';
import { SHARED_CLIENTS, SHARED_INFO, sharedClients, stopSharedBrowser } from '../lib/browser.ts';

/**
 * The shared browser every command connects to (lib/browser.ts starts it on
 * first use). It closes itself after QA_BROWSER_IDLE_MINUTES (default 15) with
 * no command connected.
 *   npm run browser:stop     close it now
 */

if (process.argv.includes('--stop')) {
  console.log(stopSharedBrowser() ? 'Shared browser stopped.' : 'No shared browser was running.');
  process.exit(0);
}

const idleMinutes = Number(process.env.QA_BROWSER_IDLE_MINUTES) > 0 ? Number(process.env.QA_BROWSER_IDLE_MINUTES) : 15;
const headless = !watching();
const server = await chromium.launchServer({ headless });
mkdirSync(SHARED_CLIENTS, { recursive: true });
writeFileSync(SHARED_INFO, JSON.stringify({ wsEndpoint: server.wsEndpoint(), pid: process.pid, headless }));
const started = Date.now();

async function shutdown(): Promise<void> {
  rmSync(SHARED_INFO, { force: true });
  await server.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
// A user closing the visible window ends the server too.
server.process().once('exit', () => void shutdown());

setInterval(() => {
  if (sharedClients() > 0) return;
  // The clients folder changes whenever a command connects or leaves.
  const lastActivity = Math.max(started, statSync(SHARED_CLIENTS).mtimeMs);
  if (Date.now() - lastActivity > idleMinutes * 60_000) void shutdown();
}, 30_000);
