import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { Db } from "@paperclipai/db";
import { verifyExperiment, type VerifyDeps } from "./verify.js";

/**
 * Replay verification without a GPU or a repository.
 *
 * Both the git runner and the executor are injected, so these tests exercise the
 * decision logic - which is where a wrong answer would matter - rather than the
 * plumbing. A divergence has to be reported, never silently normalized.
 */

interface ExperimentStub {
  id?: string;
  sequence?: number;
  gitSha?: string | null;
  valBpb?: number | null;
  verdict?: string;
}

interface StudyStub {
  noiseFloorBpb?: number | null;
  killAfterSec?: number;
}

function makeHarness(options: { experiment?: ExperimentStub; study?: StudyStub } = {}) {
  const gitCalls: string[][] = [];
  const executorKillAfter: number[] = [];
  let metricsPayload: Record<string, unknown> | null = null;

  const experiment = {
    id: options.experiment?.id ?? "exp-1",
    companyId: "co-1",
    studyId: "study-1",
    sequence: options.experiment?.sequence ?? 12,
    gitSha: options.experiment?.gitSha === undefined ? "a".repeat(40) : options.experiment.gitSha,
    valBpb: options.experiment?.valBpb === undefined ? 1.024859 : options.experiment.valBpb,
    verdict: options.experiment?.verdict ?? "keep",
  };
  const study = {
    id: "study-1",
    companyId: "co-1",
    repoPath: "/tmp/autoresearch",
    tag: "mar5",
    noiseFloorBpb: options.study?.noiseFloorBpb === undefined ? 0.01 : options.study.noiseFloorBpb,
    killAfterSec: options.study?.killAfterSec ?? 900,
  };

  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => Promise.resolve([{ experiment, study }]) }),
      }),
    }),
  } as unknown as Db;

  const deps: VerifyDeps = {
    executorPath: "/nonexistent/run-experiment.mjs",
    git: async (_cwd, args) => {
      gitCalls.push(args);
      return { stdout: "", stderr: "" };
    },
    runExecutor: async ({ outPath, killAfterSec }) => {
      executorKillAfter.push(killAfterSec);
      if (metricsPayload) await writeFile(outPath, JSON.stringify(metricsPayload), "utf8");
      return { exitCode: 0 };
    },
  };

  return {
    db,
    deps,
    gitCalls,
    executorKillAfter,
    /** Sets what the "executor" will have written to its metrics file. */
    setMetrics: (payload: Record<string, unknown> | null) => {
      metricsPayload = payload;
    },
    subject: { companyId: "co-1", experimentId: experiment.id },
  };
}

/** A metrics file the executor writes for a trustworthy run. */
function succeededMetrics(valBpb: number): Record<string, unknown> {
  return {
    status: "succeeded",
    metrics: { valBpb, numSteps: 32, trainingSeconds: 311.5 },
    invalidReason: null,
    plausibilityFailures: [],
  };
}

describe("verifyExperiment", () => {
  it("reproduces the record when the replay lands inside the noise floor", async () => {
    const h = makeHarness();
    h.setMetrics(succeededMetrics(1.0261));

    const result = await verifyExperiment(h.db, h.subject, h.deps);

    expect(result.disposition).toBe("reproduced");
    expect(result.observedValBpb).toBeCloseTo(1.0261, 6);
    // 1.0261 - 1.024859 = 0.001241, inside the 0.01 floor.
    expect(result.delta).toBeCloseTo(0.001241, 6);
    expect(result.reason).toMatch(/within the 0\.01 noise floor/);
  });

  it("reports a divergence when the replay lands outside the noise floor", async () => {
    const h = makeHarness();
    // A hand-faked "improvement" to 0.9 does not survive a replay of the commit.
    h.setMetrics(succeededMetrics(0.9));

    const result = await verifyExperiment(h.db, h.subject, h.deps);

    expect(result.disposition).toBe("diverged");
    expect(result.delta).toBeLessThan(-0.1);
    expect(result.reason).toMatch(/exceeds the .* noise floor/);
    // A divergence is a finding, not something to write back.
    expect(result.recordedValBpb).toBeCloseTo(1.024859, 6);
  });

  it("treats a boundary-value delta as reproduced, not diverged", async () => {
    const h = makeHarness();
    h.setMetrics(succeededMetrics(1.024859 + 0.01));

    const result = await verifyExperiment(h.db, h.subject, h.deps);

    expect(result.disposition).toBe("reproduced");
  });

  it("treats a delta just past the floor as diverged", async () => {
    const h = makeHarness();
    h.setMetrics(succeededMetrics(1.024859 + 0.0101));

    const result = await verifyExperiment(h.db, h.subject, h.deps);

    expect(result.disposition).toBe("diverged");
  });

  it("is inconclusive when the executor exits non-zero", async () => {
    const h = makeHarness();
    const result = await verifyExperiment(h.db, h.subject, h.deps);
    // No metrics file at all: an executor that never wrote one produced nothing.
    expect(result.disposition).toBe("inconclusive");
    expect(result.reason).toMatch(/did not produce a usable metric/i);
  });

  it("is inconclusive and surfaces the invalid reason when the replay is rejected", async () => {
    const h = makeHarness();
    h.setMetrics({
      status: "invalid",
      invalidReason: "smoke_test_run",
      plausibilityFailures: [],
      metrics: null,
    });

    const result = await verifyExperiment(h.db, h.subject, h.deps);

    expect(result.disposition).toBe("inconclusive");
    expect(result.reason).toMatch(/smoke_test_run/);
  });

  it("is inconclusive when a succeeded payload carries no val_bpb", async () => {
    const h = makeHarness();
    h.setMetrics({ status: "succeeded", metrics: { numSteps: 32 } });

    const result = await verifyExperiment(h.db, h.subject, h.deps);

    expect(result.disposition).toBe("inconclusive");
    expect(result.reason).toMatch(/no val_bpb/i);
  });

  it("uses the study noise floor as the comparison tolerance", async () => {
    const h = makeHarness();
    h.setMetrics(succeededMetrics(1.024859));
    const result = await verifyExperiment(h.db, h.subject, h.deps);
    expect(result.tolerance).toBe(0.01);
    expect(result.noiseFloorBpb).toBe(0.01);
  });

  it("falls back to a small tolerance when no noise floor was measured", async () => {
    const h = makeHarness({ study: { noiseFloorBpb: null } });
    h.setMetrics(succeededMetrics(1.024859));
    const result = await verifyExperiment(h.db, h.subject, h.deps);
    // A study that never ran the baseline repeatedly has no measured spread, so the
    // comparison falls back rather than pretending to a precision it lacks.
    expect(result.tolerance).toBeGreaterThan(0);
    expect(result.noiseFloorBpb).toBeNull();
  });

  it("is inconclusive for a crash, which has no metric to replay", async () => {
    const h = makeHarness({ experiment: { valBpb: null, verdict: "crash" } });
    const result = await verifyExperiment(h.db, h.subject, h.deps);
    expect(result.disposition).toBe("inconclusive");
    expect(result.reason).toMatch(/no metric/i);
    expect(h.gitCalls.filter((args) => args[1] === "add")).toHaveLength(0);
  });

  it("is inconclusive when the experiment recorded no commit", async () => {
    const h = makeHarness({ experiment: { gitSha: null } });
    const result = await verifyExperiment(h.db, h.subject, h.deps);
    expect(result.disposition).toBe("inconclusive");
    expect(result.reason).toMatch(/no commit/i);
  });

  it("checks out detached and always prunes, so a replay cannot move the branch", async () => {
    const h = makeHarness();
    h.setMetrics(succeededMetrics(1.024859));
    await verifyExperiment(h.db, h.subject, h.deps);

    const add = h.gitCalls.find((args) => args[1] === "add");
    expect(add).toBeDefined();
    expect(add).toContain("--detach");
    // Pruned even though nothing observable failed.
    expect(h.gitCalls.some((args) => args[1] === "remove")).toBe(true);
  });

  it("prunes the scratch worktree even when the metrics file is missing", async () => {
    const h = makeHarness();
    await verifyExperiment(h.db, h.subject, h.deps);
    expect(h.gitCalls.some((args) => args[1] === "remove")).toBe(true);
  });

  it("gives the replay the study's kill budget, not a shorter one", async () => {
    const h = makeHarness({ study: { killAfterSec: 900 } });
    h.setMetrics(succeededMetrics(1.024859));
    await verifyExperiment(h.db, h.subject, h.deps);
    expect(h.executorKillAfter[0]).toBe(900);
  });

  it("throws when the experiment does not exist", async () => {
    const h = makeHarness();
    const emptyDb = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => Promise.resolve([]) }),
        }),
      }),
    } as unknown as Db;
    await expect(
      verifyExperiment(emptyDb, { companyId: "co-1", experimentId: "nope" }, h.deps),
    ).rejects.toThrow(/not found/i);
  });
});
