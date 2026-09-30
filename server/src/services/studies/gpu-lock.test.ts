import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_GPU_LOCK_TTL_SECONDS,
  acquireGpuLock,
  inspectGpuLock,
  isProcessAlive,
  releaseGpuLock,
} from "./gpu-lock.js";

const tempRoots: string[] = [];

function tempLockFile(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-gpu-lock-"));
  tempRoots.push(root);
  return join(root, "gpu.lock");
}

function writeRawLock(lockFilePath: string, payload: unknown): void {
  writeFileSync(lockFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** A pid that is almost certainly not running and, on Windows, large enough not to be 0 or a system pid. */
function deadPid(): number {
  return 0x7ff0_0001;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("acquireGpuLock", () => {
  it("creates the lock exclusively and records the owner", () => {
    const lockFile = tempLockFile();
    const result = acquireGpuLock(lockFile, { ownerPid: process.pid, experimentId: "exp-1" });

    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    expect(result.owner.pid).toBe(process.pid);
    expect(result.owner.experimentId).toBe("exp-1");

    const onDisk = JSON.parse(readFileSync(lockFile, "utf8")) as Record<string, unknown>;
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.experimentId).toBe("exp-1");
    expect(typeof onDisk.acquiredAt).toBe("string");
    expect(onDisk.ttlSeconds).toBe(DEFAULT_GPU_LOCK_TTL_SECONDS);
  });

  it("refuses a second acquirer while a live pid holds the lock", () => {
    const lockFile = tempLockFile();
    expect(acquireGpuLock(lockFile, { ownerPid: process.pid }).acquired).toBe(true);

    const second = acquireGpuLock(lockFile, { ownerPid: process.pid, experimentId: "exp-2" });
    expect(second.acquired).toBe(false);
    if (second.acquired) return;
    expect(second.reason).toBe("held");
    expect(second.heldBy?.experimentId).toBeNull();
  });

  it("takes over a lock whose owner pid is dead", () => {
    const lockFile = tempLockFile();
    // Fresh timestamp and a generous TTL: only the dead pid can explain the takeover.
    writeRawLock(lockFile, {
      experimentId: "exp-orphan",
      pid: deadPid(),
      acquiredAt: new Date().toISOString(),
      host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "",
      ttlSeconds: 3600,
    });

    const result = acquireGpuLock(lockFile, { ownerPid: process.pid, experimentId: "exp-new" });
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    expect(result.owner.experimentId).toBe("exp-new");

    const onDisk = JSON.parse(readFileSync(lockFile, "utf8")) as Record<string, unknown>;
    expect(onDisk.experimentId).toBe("exp-new");
  });

  it("takes over a lock whose lease has expired even though the pid is alive", () => {
    const lockFile = tempLockFile();
    writeRawLock(lockFile, {
      experimentId: "exp-stale",
      pid: process.pid,
      // A lease measured from an hour ago with a five second TTL is unambiguously expired,
      // so the pid cannot be the reason this lock is being taken over.
      acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
      host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "",
      ttlSeconds: 5,
    });

    const result = acquireGpuLock(lockFile, { ownerPid: process.pid, experimentId: "exp-new" });
    expect(result.acquired).toBe(true);
  });

  it("keeps a live lock whose lease has not expired", () => {
    const lockFile = tempLockFile();
    writeRawLock(lockFile, {
      experimentId: "exp-live",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "",
      ttlSeconds: 3600,
    });

    const result = acquireGpuLock(lockFile, { ownerPid: process.pid });
    expect(result.acquired).toBe(false);
  });

  it("takes over a lock whose contents are corrupt rather than honouring garbage", () => {
    const lockFile = tempLockFile();
    writeFileSync(lockFile, "not json at all", "utf8");

    const result = acquireGpuLock(lockFile, { ownerPid: process.pid, experimentId: "exp-new" });
    expect(result.acquired).toBe(true);
  });

  it("creates the parent directory so the first acquirer does not have to provision it", () => {
    const root = mkdtempSync(join(tmpdir(), "paperclip-gpu-lock-nested-"));
    tempRoots.push(root);
    const lockFile = join(root, "nested", "deeper", "gpu.lock");

    expect(acquireGpuLock(lockFile, { ownerPid: process.pid }).acquired).toBe(true);
  });
});

describe("inspectGpuLock", () => {
  it("reports no lock when the file does not exist", () => {
    const lockFile = tempLockFile();
    expect(inspectGpuLock(lockFile)).toEqual({ held: false, owner: null, corrupt: false });
  });

  it("reads the owner without mutating the file", () => {
    const lockFile = tempLockFile();
    acquireGpuLock(lockFile, { ownerPid: process.pid, experimentId: "exp-1", ttlSeconds: 42 });
    const before = readFileSync(lockFile, "utf8");

    const inspected = inspectGpuLock(lockFile);
    expect(inspected.held).toBe(true);
    expect(inspected.corrupt).toBe(false);
    expect(inspected.owner?.experimentId).toBe("exp-1");
    expect(inspected.owner?.ttlSeconds).toBe(42);
    expect(readFileSync(lockFile, "utf8")).toBe(before);
  });

  it("flags a corrupt lock instead of throwing", () => {
    const lockFile = tempLockFile();
    writeFileSync(lockFile, "{", "utf8");
    expect(inspectGpuLock(lockFile)).toEqual({ held: true, owner: null, corrupt: true });
  });
});

describe("releaseGpuLock", () => {
  it("removes a lock the owner holds", () => {
    const lockFile = tempLockFile();
    acquireGpuLock(lockFile, { ownerPid: process.pid, experimentId: "exp-1" });

    expect(releaseGpuLock(lockFile, { ownerPid: process.pid })).toBe(true);
    expect(inspectGpuLock(lockFile).held).toBe(false);
  });

  it("refuses to release a lock owned by a different pid", () => {
    const lockFile = tempLockFile();
    acquireGpuLock(lockFile, { ownerPid: process.pid, experimentId: "exp-1" });

    // A slow process must not unlock the card out from under the experiment that legitimately
    // holds it now.
    expect(releaseGpuLock(lockFile, { ownerPid: deadPid() })).toBe(false);
    expect(inspectGpuLock(lockFile).held).toBe(true);
  });

  it("is a no-op when no lock exists", () => {
    expect(releaseGpuLock(tempLockFile())).toBe(false);
  });

  it("lets the next acquirer take the card immediately after release", () => {
    const lockFile = tempLockFile();
    acquireGpuLock(lockFile, { ownerPid: process.pid });
    releaseGpuLock(lockFile, { ownerPid: process.pid });
    expect(acquireGpuLock(lockFile, { ownerPid: process.pid, experimentId: "exp-2" }).acquired).toBe(
      true,
    );
  });
});

describe("isProcessAlive", () => {
  it("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("reports a non-positive or non-integer pid as dead", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  it("reports ESRCH as dead and never mistakes another error for death", () => {
    const realKill = process.kill;
    try {
      process.kill = ((pid: number, signal?: string | number) => {
        if (signal !== 0) return realKill(pid, signal as NodeJS.Signals);
        if (pid === 111) {
          const error: NodeJS.ErrnoException = new Error("kill ESRCH");
          error.code = "ESRCH";
          throw error;
        }
        const error: NodeJS.ErrnoException = new Error("kill EPERM");
        error.code = "EPERM";
        throw error;
      }) as typeof process.kill;

      expect(isProcessAlive(111)).toBe(false);
      // EPERM means the process exists but belongs to another user. Treating that as dead
      // would hand the card to a second trainer.
      expect(isProcessAlive(222)).toBe(true);
    } finally {
      process.kill = realKill;
    }
  });
});
