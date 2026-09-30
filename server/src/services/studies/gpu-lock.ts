import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Single-GPU coordination on the filesystem.
 *
 * This COMPLEMENTS rather than replaces the database partial unique index
 * `experiments_single_running_per_study`. The two answer different questions:
 *
 * - The index arbitrates WHICH experiment may start. It is atomic and it is
 *   authoritative inside the database, which is why `beginExperiment` leans on a
 *   conditional INSERT rather than re-checking in application logic.
 * - This lock stops a leaked trainer that is still holding the card. A database row
 *   cannot do that: it says a run was started, not that an OS process is still alive,
 *   and an orphaned `uv`/python process after a host restart is invisible to every
 *   database query. On Windows there is no process group, and `child.kill()` reaches
 *   only the direct child.
 *
 * A leak is worse than a crash. A crashed trainer is loud: it produces no metrics, the
 * run is marked crashed, and the verdict is `reset_to_sha`. A leaked trainer is quiet:
 * it keeps holding VRAM while the next run trains beside it, every subsequent metric is
 * contaminated, and the study still looks healthy. So the lock is deliberately
 * self-healing: a lock whose owner is dead, or whose TTL has expired, is taken over
 * rather than respected.
 */

/** Default lease. Must exceed the longest plausible wall clock of one experiment. */
export const DEFAULT_GPU_LOCK_TTL_SECONDS = 1800;

export interface GpuLockOwner {
  experimentId: string | null;
  pid: number;
  acquiredAt: string;
  host: string;
  ttlSeconds: number;
}

export interface InspectGpuLockResult {
  held: boolean;
  owner: GpuLockOwner | null;
  /** Unparsable or missing metadata; treat as a corrupt lock and take it over. */
  corrupt: boolean;
}

export type AcquireGpuLockResult =
  | { acquired: true; owner: GpuLockOwner }
  | { acquired: false; heldBy: GpuLockOwner | null; reason: "held" | "unreadable" };

function parseOwner(raw: string): GpuLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<GpuLockOwner>;
    if (typeof parsed?.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    if (typeof parsed.acquiredAt !== "string") return null;
    return {
      experimentId: typeof parsed.experimentId === "string" ? parsed.experimentId : null,
      pid: parsed.pid,
      acquiredAt: parsed.acquiredAt,
      host: typeof parsed.host === "string" ? parsed.host : "",
      ttlSeconds: typeof parsed.ttlSeconds === "number" ? parsed.ttlSeconds : DEFAULT_GPU_LOCK_TTL_SECONDS,
    };
  } catch {
    return null;
  }
}

/**
 * Liveness probe for the recorded pid.
 *
 * Signal 0 performs the permission and existence checks without delivering a signal.
 * ESRCH means "no such process" and is the only result that proves the owner is gone.
 * EPERM means the process exists but belongs to another user, which is still alive as
 * far as GPU exclusivity is concerned, so it is treated as live. Everything else falls
 * back to treating the pid as live, because a false "dead" hands the card to a second
 * trainer and that is the failure this whole module exists to prevent.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function readOwner(lockFilePath: string): { owner: GpuLockOwner | null; corrupt: boolean; held: boolean } {
  let raw: string;
  try {
    raw = readFileSync(lockFilePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { owner: null, corrupt: false, held: false };
    return { owner: null, corrupt: true, held: true };
  }
  const owner = parseOwner(raw);
  return { owner, corrupt: owner === null, held: true };
}

/**
 * Non-mutating look at the lock. Used by diagnostics and by the executor's pre-flight
 * sweep; it never creates or removes the file.
 */
export function inspectGpuLock(lockFilePath: string): InspectGpuLockResult {
  const { owner, corrupt, held } = readOwner(lockFilePath);
  return { held, owner, corrupt };
}

export interface AcquireGpuLockOptions {
  /** pid of the process that will own the trainer. */
  ownerPid: number;
  experimentId?: string | null;
  ttlSeconds?: number;
}

function writeOwnerExclusive(lockFilePath: string, owner: GpuLockOwner): boolean {
  mkdirSync(dirname(lockFilePath), { recursive: true });
  try {
    // `wx` fails when the path already exists, which is what makes the create atomic
    // against a concurrent acquirer. A plain write would truncate a live lock.
    const fd = openSync(lockFilePath, "wx");
    try {
      writeSync(fd, `${JSON.stringify(owner, null, 2)}\n`, null, "utf8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Take the lock, or report who holds it.
 *
 * Takeover happens when the recorded pid is dead OR the lease has expired. Anything less
 * than those two means a live trainer may still be on the card, and the caller must fall
 * through to the next candidate rather than queue behind it: this study has one GPU and
 * there is nothing useful to do while it is busy.
 */
export function acquireGpuLock(
  lockFilePath: string,
  options: AcquireGpuLockOptions,
): AcquireGpuLockResult {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_GPU_LOCK_TTL_SECONDS;
  const owner: GpuLockOwner = {
    experimentId: options.experimentId ?? null,
    pid: options.ownerPid,
    acquiredAt: new Date().toISOString(),
    host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "",
    ttlSeconds,
  };

  if (writeOwnerExclusive(lockFilePath, owner)) {
    return { acquired: true, owner };
  }

  const existing = readOwner(lockFilePath);
  if (!existing.held) {
    // The holder released between the failed create and this read. Retry once; if that
    // also loses the race the caller sees a live holder and falls through.
    if (writeOwnerExclusive(lockFilePath, owner)) return { acquired: true, owner };
    const retried = readOwner(lockFilePath);
    return { acquired: false, heldBy: retried.owner, reason: "held" };
  }

  const stale = existing.corrupt || existing.owner === null || isStale(existing.owner);
  if (!stale) {
    return { acquired: false, heldBy: existing.owner, reason: "held" };
  }

  // Takeover races are resolved by whoever unlinks first; the loser's unlink can leave the
  // file missing, so the write is retried after a failed create as well. Both retries are
  // bounded: a live holder will simply keep reporting itself on the next call.
  try {
    unlinkSync(lockFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return { acquired: false, heldBy: existing.owner, reason: "unreadable" };
    }
  }
  if (writeOwnerExclusive(lockFilePath, owner)) {
    return { acquired: true, owner };
  }
  const afterRace = readOwner(lockFilePath);
  return { acquired: false, heldBy: afterRace.owner, reason: "held" };
}

function isStale(owner: GpuLockOwner): boolean {
  // The lease is an independent escape hatch, checked FIRST: whatever is holding the card has
  // overrun a budget the operator already accepted, so the framework is entitled to reclaim
  // it. The default lease clears the study's own kill, so a live trainer cannot normally get
  // here.
  const acquiredAt = Date.parse(owner.acquiredAt);
  const ttlMs = (owner.ttlSeconds > 0 ? owner.ttlSeconds : DEFAULT_GPU_LOCK_TTL_SECONDS) * 1000;
  if (!Number.isFinite(acquiredAt)) return true;
  if (Date.now() - acquiredAt > ttlMs) return true;
  // A pid on another host says nothing about this host's processes, so the pid probe is only
  // meaningful when the lock was written here.
  const sameHost = owner.host === (process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "");
  return sameHost && !isProcessAlive(owner.pid);
}

/**
 * Release the lock. Only the owner may release, so a slow process cannot unlock the card
 * out from under the experiment that legitimately holds it now.
 */
export function releaseGpuLock(lockFilePath: string, options?: { ownerPid?: number }): boolean {
  const { owner, held } = readOwner(lockFilePath);
  if (!held) return false;
  if (options?.ownerPid !== undefined && owner !== null && owner.pid !== options.ownerPid) {
    return false;
  }
  try {
    unlinkSync(lockFilePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}
