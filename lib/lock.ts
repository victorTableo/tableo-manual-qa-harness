import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from './environments.ts';

/**
 * One run per environment at a time. All runs share the login's server session,
 * and the app keeps the active restaurant on the server, so two runs at once
 * would switch each other's restaurant. Re-entrant within a process; a lock left
 * by a process that no longer exists is taken over.
 */

const held = new Map<string, number>();

function lockFile(environment: string): string {
  return path.resolve(process.cwd(), '.auth', `${environment}.lock`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The current owner, or null when the file is missing, unreadable (half-written) or its process is gone. */
function liveOwner(file: string): { pid: number; since: string } | null {
  try {
    const owner = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; since: string };
    return owner.pid !== process.pid && alive(owner.pid) ? owner : null;
  } catch {
    return null;
  }
}

export function acquireLock(environment: string): void {
  const count = held.get(environment) ?? 0;
  if (count > 0) {
    held.set(environment, count + 1);
    return;
  }
  const file = lockFile(environment);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // 'wx' creates the file only if it does not exist: two runs can never both win.
      const fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
      closeSync(fd);
      held.set(environment, 1);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = liveOwner(file);
      if (owner) {
        throw new ConfigurationError(
          `BLOCKED: another QA run is using "${environment}" (process ${owner.pid}, since ${owner.since}). ` +
            `Wait for it to finish, or delete ${path.relative(process.cwd(), file)} if that run is gone.`,
        );
      }
      rmSync(file, { force: true }); // stale: its process is gone or the file is unreadable
    }
  }
  throw new ConfigurationError(`BLOCKED: could not take the run lock for "${environment}"; try again.`);
}

export function releaseLock(environment: string): void {
  const count = held.get(environment) ?? 0;
  if (count > 1) {
    held.set(environment, count - 1);
    return;
  }
  held.delete(environment);
  rmSync(lockFile(environment), { force: true });
}
