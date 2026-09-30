import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  experimentVerdicts,
  experiments,
  heartbeatRuns,
  projects,
  studies,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ORPHAN_RECONCILE_SLACK_SECONDS,
  SINGLE_RUNNING_INDEX,
  experimentsService,
  type BeginExperimentResult,
  type ExperimentRow,
} from "../services/studies/experiments.ts";
import { isUniqueViolation } from "../db-errors.ts";
import { studyPaths } from "../services/studies/paths.ts";

const execFileAsync = promisify(execFile);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres study experiments tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

/**
 * The metrics payload the executor writes for a full-budget run.
 *
 * `attestation.wallClockSeconds` exceeds `totalSeconds` on purpose: the difference is
 * interpreter startup, runtime detection, tokenizer load, and autotune, which is exactly the
 * preflight split the settle path derives.
 */
function metricsPayload(): Record<string, unknown> {
  return {
    status: "succeeded",
    sequence: 1,
    exitCode: 0,
    signal: null,
    killedBy: null,
    invalidReason: null,
    plausibilityFailures: [],
    metrics: {
      valBpb: 1.024859,
      trainingSeconds: 311.5,
      totalSeconds: 672,
      peakVramMb: 2985.3,
      mfuPercent: 10.01,
      totalTokensM: 16.8,
      numSteps: 32,
      numParamsM: 50.3,
      depth: 8,
      dataset: "tinystories",
      trainBatchSize: 8,
      evalBatchSize: 8,
      activationCheckpointing: true,
    },
    provenance: { gpu: "NVIDIA GeForce RTX 4060 Ti", gpuVram: "16.4 GB" },
    attestation: {
      executorVersion: "1",
      argv: ["uv", "run", "--frozen", "--no-sync", "train.py"],
      worktreePath: path.join("worktrees", "gpt-4070"),
      worktreeHeadBefore: "a".repeat(40),
      worktreeHeadAfter: "a".repeat(40),
      envKeys: ["AUTORESEARCH_CACHE_DIR", "UV_PROJECT_ENVIRONMENT"],
      autotuneCold: true,
      autotuneSelectedBatchSize: 8,
      startedAt: new Date().toISOString(),
      wallClockSeconds: 676.6,
      killedBy: null,
    },
  };
}

function payloadWithValBpb(valBpb: number): Record<string, unknown> {
  const payload = metricsPayload();
  payload.metrics = { ...(payload.metrics as Record<string, unknown>), valBpb };
  return payload;
}

/** Narrow an arbitration result, failing the test instead of a cast when it lost the GPU. */
function acquired(result: BeginExperimentResult): ExperimentRow {
  if (!result.acquired) throw new Error("expected the GPU arbitration to succeed");
  return result.experiment;
}

describeEmbeddedPostgres("study experiments service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-studies-experiments-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    // activity_log references agents and heartbeat_runs, so it has to go first.
    await db.delete(activityLog);
    await db.delete(experimentVerdicts);
    await db.delete(heartbeatRuns);
    await db.delete(studies);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  async function createGitRepo(): Promise<string> {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-study-repo-"));
    tempRoots.push(repoRoot);
    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "paperclip-test@example.com"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "Paperclip Test"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "train.py"), "# baseline\n", "utf8");
    await execFileAsync("git", ["add", "train.py"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
    return repoRoot;
  }

  interface Harness {
    companyId: string;
    agentId: string;
    studyId: string;
    repoPath: string;
    metricsDir: string;
    resultsTsv: string;
    service: ReturnType<typeof experimentsService>;
  }

  /**
   * Seed one company, one agent, and one study on a real git repository, then hand back the
   * service wired to that study's real data directory. Nothing is stubbed: the metrics JSON is
   * written to the path the executor would have written it to and read back from disk.
   */
  async function seedStudy(
    options: { noiseFloorBpb?: number | null; bestValBpb?: number | null } = {},
  ): Promise<Harness> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const studyId = randomUUID();
    const projectId = randomUUID();
    const repoPath = await createGitRepo();
    const paths = studyPaths({ repoPath, tag: "gpt-4070" });

    await db.insert(companies).values({
      id: companyId,
      name: "Autoresearch Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Autoresearch" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Proposer" });
    await db.insert(studies).values({
      id: studyId,
      companyId,
      projectId,
      name: "GPT-4070 study",
      tag: "gpt-4070",
      branchName: "autoresearch/gpt-4070",
      baseRef: "main",
      repoPath,
      status: "active",
      venvPath: paths.venvDir,
      timeBudgetSec: 300,
      killAfterSec: 900,
      noiseFloorBpb: options.noiseFloorBpb === undefined ? 0.01 : options.noiseFloorBpb,
      bestValBpb: options.bestValBpb ?? null,
      exploreEveryN: 4,
      maxSimplificationKeepsPerWindow: 1,
      resultsTsvPath: paths.resultsTsv,
      lastKeptSha: "b".repeat(40),
    });

    await mkdir(paths.metricsDir, { recursive: true });
    await mkdir(paths.logDir, { recursive: true });

    return {
      companyId,
      agentId,
      studyId,
      repoPath,
      metricsDir: paths.metricsDir,
      resultsTsv: paths.resultsTsv,
      service: experimentsService(db),
    };
  }

  async function writeMetrics(harness: Harness, sequence: number, payload: Record<string, unknown>) {
    await writeFile(
      path.join(harness.metricsDir, `${sequence}.json`),
      `${JSON.stringify({ ...payload, sequence }, null, 2)}\n`,
      "utf8",
    );
  }

  async function seedHeartbeatRun(harness: Harness): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: harness.companyId,
      agentId: harness.agentId,
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    return runId;
  }

  async function studyRow(studyId: string) {
    return db.select().from(studies).where(eq(studies.id, studyId)).then((rows) => rows[0] ?? null);
  }

  /** Re-reads an experiment. Snapshots captured before a settle are stale by construction. */
  async function experimentRow(studyId: string, experimentId: string) {
    return db
      .select()
      .from(experiments)
      .where(and(eq(experiments.studyId, studyId), eq(experiments.id, experimentId)))
      .then((rows) => rows[0] ?? null);
  }

  /** Begin a run, write the metrics the executor would have written, settle, and adjudicate. */
  async function runExperiment(
    harness: Harness,
    input: {
      description: string;
      valBpb: number;
      complexityDeltaLines?: number | null;
      kind?: "baseline" | "hypothesis";
      gitSha: string;
      adjudicate?: boolean;
    },
  ) {
    const experiment = acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: input.kind ?? "hypothesis",
        description: input.description,
        complexityDeltaLines: input.complexityDeltaLines ?? null,
        gitSha: input.gitSha,
      }),
    );
    await writeMetrics(harness, experiment.sequence, payloadWithValBpb(input.valBpb));

    const settled = await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId: null,
      outcome: "succeeded",
    });
    if (!settled.experiment) throw new Error("expected the settle to produce an experiment");

    if (input.adjudicate === false) return { experiment: settled.experiment, verdict: null };
    const verdict = await harness.service.adjudicate({
      companyId: harness.companyId,
      experimentId: settled.experiment.id,
    });
    return { experiment: verdict.experiment, verdict };
  }

  it("starts the baseline at sequence 1 and refuses a second baseline while one runs", async () => {
    const harness = await seedStudy();

    const first = acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "baseline",
        description: "baseline characterization run 1",
        isBaseline: true,
        gitSha: "a".repeat(40),
      }),
    );
    // Sequence 1 belongs to the baseline, which is what fixes the results.tsv row order for
    // the whole study.
    expect(first.sequence).toBe(1);
    expect(first.kind).toBe("baseline");

    // The baseline is a series of three runs so the noise floor is measured rather than
    // assumed, and only one of them can hold the GPU at a time.
    const overlapping = await harness.service.beginExperiment({
      companyId: harness.companyId,
      studyId: harness.studyId,
      kind: "baseline",
      description: "baseline characterization run 2",
      isBaseline: true,
      gitSha: "a".repeat(40),
    });
    expect(overlapping).toEqual({ acquired: false });

    const running = await harness.service.listExperiments(harness.companyId, harness.studyId, {
      status: "running",
    });
    expect(running).toHaveLength(1);
    expect(await harness.service.nextSequence(harness.studyId)).toBe(2);
  });

  it("lets exactly one of two concurrent begins take the GPU", async () => {
    const harness = await seedStudy();

    const [first, second] = await Promise.all([
      harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "first candidate",
        gitSha: "d".repeat(40),
      }),
      harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "second candidate",
        gitSha: "e".repeat(40),
      }),
    ]);

    // Both calls read the same next sequence before either inserts, so nothing but the partial
    // unique index can decide this.
    expect([first.acquired, second.acquired].filter(Boolean)).toHaveLength(1);
    // The winner took sequence 1, so the next free sequence is 2. nextSequence is the value to
    // assign next, not the current maximum.
    expect(await harness.service.nextSequence(harness.studyId)).toBe(2);
    expect((await studyRow(harness.studyId))?.experimentCount).toBe(1);
  });

  it("proves experiments_single_running_per_study is the arbiter by violating it directly", async () => {
    const harness = await seedStudy();
    acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "candidate",
        gitSha: "d".repeat(40),
      }),
    );

    // A raw second `running` row for the same study, written outside the service, has to be
    // rejected by the index itself. Nothing in application logic participates here.
    //
    // Assert through the repo's own helper rather than a message regex: drizzle wraps the
    // failure in "Failed query: ..." and the constraint name lives on the nested cause, so it
    // never reaches the top-level message.
    let smuggled: unknown;
    try {
      await db.insert(experiments).values({
        companyId: harness.companyId,
        studyId: harness.studyId,
        sequence: 99,
        kind: "hypothesis",
        description: "smuggled second run",
        status: "running",
        autotuneCold: false,
      });
    } catch (error) {
      smuggled = error;
    }
    expect(smuggled).toBeDefined();
    expect(isUniqueViolation(smuggled, SINGLE_RUNNING_INDEX)).toBe(true);
  });

  it("converts a stale running row into a crash with a verdict row and leaves a fresh one alone", async () => {
    const harness = await seedStudy();
    const stale = acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "stale candidate",
        gitSha: "f".repeat(40),
      }),
    );

    const setAge = async (seconds: number) => {
      await db
        .update(experiments)
        .set({ startedAt: new Date(Date.now() - seconds * 1000) })
        .where(eq(experiments.id, stale.id));
    };

    // 60s kill + 30s grace + 120s slack = a 210s budget. A 200s-old row is still inside the
    // window, so reconciliation must leave it alone.
    await setAge(200);
    const insideWindow = await harness.service.reconcileOrphans(
      harness.companyId,
      harness.studyId,
      { killAfterSec: 60, graceSec: 30 },
    );
    expect(insideWindow.reconciled).toBe(0);
    expect(ORPHAN_RECONCILE_SLACK_SECONDS).toBe(120);

    await setAge(400);
    const outsideWindow = await harness.service.reconcileOrphans(
      harness.companyId,
      harness.studyId,
      { killAfterSec: 60, graceSec: 30 },
    );
    expect(outsideWindow.reconciled).toBe(1);
    expect(outsideWindow.experimentIds).toEqual([stale.id]);

    const [crashed] = await harness.service.listExperiments(harness.companyId, harness.studyId);
    expect(crashed?.status).toBe("crashed");
    expect(crashed?.verdict).toBe("crash");
    expect(crashed?.valBpb).toBeNull();
    expect(crashed?.errorExcerpt).toContain("orphaned run");

    const verdicts = await db
      .select()
      .from(experimentVerdicts)
      .where(eq(experimentVerdicts.experimentId, stale.id));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.gitAction).toBe("reset_to_sha");
    expect(verdicts[0]?.targetSha).toBe("b".repeat(40));
    expect(verdicts[0]?.actorType).toBe("system");
    expect(verdicts[0]?.reason).toContain("orphaned run");

    const study = await studyRow(harness.studyId);
    expect(study?.crashCount).toBe(1);
    expect(study?.consecutiveCrashes).toBe(1);

    // A fresh running row survives: the slack exists precisely so a live experiment is never
    // stamped crashed out from under itself.
    acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "fresh candidate",
        gitSha: "0".repeat(40),
      }),
    );
    const second = await harness.service.reconcileOrphans(harness.companyId, harness.studyId, {
      killAfterSec: 60,
      graceSec: 30,
    });
    expect(second.reconciled).toBe(0);
    expect(
      await harness.service.listExperiments(harness.companyId, harness.studyId, { status: "running" }),
    ).toHaveLength(1);
  });

  it("copies metrics on a succeeded settle and freezes deltaVsBestAtTime", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0 });
    const experiment = acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "hypothesis candidate",
        gitSha: "1".repeat(40),
      }),
    );
    await writeMetrics(harness, experiment.sequence, payloadWithValBpb(0.995));

    const settled = await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId: null,
      outcome: "succeeded",
    });
    expect(settled.settled).toBe(true);
    expect(settled.metricsRejection).toBeNull();
    const row = settled.experiment as ExperimentRow;
    expect(row.valBpb).toBeCloseTo(0.995, 10);
    // Frozen against the incumbent at settle time: 0.995 - 1.0 = -0.005.
    expect(row.deltaVsBestAtTime).toBeCloseTo(-0.005, 6);
    expect(row.status).toBe("succeeded");
    expect(row.memoryGb).toBeCloseTo(2.9, 5);
    expect(row.preflightSeconds).toBeCloseTo(4.6, 5);
    expect(row.evalSeconds).toBeCloseTo(360.5, 5);
    expect(row.numSteps).toBe(32);
    expect(row.depth).toBe(8);
    expect(row.activationCheckpointing).toBe(true);
    expect(row.autotuneCold).toBe(true);
    expect(row.autotuneSelectedBatchSize).toBe(8);
    expect(row.provenance).toMatchObject({ gpu: "NVIDIA GeForce RTX 4060 Ti" });
    expect(row.attestation).toMatchObject({ executorVersion: "1" });
    expect(row.logRef).toContain("logs");

    // A later improvement must not rewrite what this run looked like when it finished.
    await harness.service.adjudicate({
      companyId: harness.companyId,
      experimentId: experiment.id,
    });
    const later = await harness.service.getExperiment(harness.companyId, experiment.id);
    expect(later?.deltaVsBestAtTime).toBeCloseTo(-0.005, 6);
  });

  it("treats a second settle as a no-op", async () => {
    const harness = await seedStudy();
    const experiment = acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "candidate",
        gitSha: "2".repeat(40),
      }),
    );
    await writeMetrics(harness, experiment.sequence, payloadWithValBpb(0.99));

    const first = await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId: null,
      outcome: "succeeded",
    });
    expect(first.settled).toBe(true);

    // A late duplicate must not re-score a run that already has a terminal outcome. With no
    // runId the service resolves "the one running experiment", and there is none left, so it
    // settles nothing. The row has to keep the first outcome.
    const second = await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId: null,
      outcome: "failed",
      error: "late duplicate",
    });
    expect(second.settled).toBe(false);
    expect(second.experiment).toBeNull();

    const persisted = await experimentRow(harness.studyId, experiment.id);
    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.valBpb).toBeCloseTo(0.99, 10);
    expect(persisted?.errorExcerpt).toBeNull();
  });

  it("leaves valBpb null on a crash settle instead of writing the 0.000000 sentinel", async () => {
    const harness = await seedStudy();
    acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "candidate that dies",
        gitSha: "3".repeat(40),
      }),
    );

    const settled = await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId: null,
      outcome: "failed",
      error: "CUDA out of memory during evaluation",
    });
    expect(settled.settled).toBe(true);
    expect(settled.experiment?.status).toBe("crashed");
    expect(settled.experiment?.valBpb).toBeNull();
    expect(settled.experiment?.deltaVsBestAtTime).toBeNull();
    expect(settled.experiment?.errorExcerpt).toContain("CUDA out of memory");

    const timedOut = acquired(
      await (async () => {
        await harness.service.adjudicate({
          companyId: harness.companyId,
          experimentId: settled.experiment?.id ?? "",
        }).catch(() => undefined);
        return harness.service.beginExperiment({
          companyId: harness.companyId,
          studyId: harness.studyId,
          kind: "hypothesis",
          description: "candidate that overruns",
          gitSha: "4".repeat(40),
        });
      })(),
    );
    const killed = await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId: null,
      outcome: "timed_out",
      error: "killed past kill_after_sec",
    });
    expect(killed.experiment?.id).toBe(timedOut.id);
    expect(killed.experiment?.status).toBe("timed_out");
    expect(killed.experiment?.valBpb).toBeNull();
  });

  it("refuses to promote an executor payload the executor itself marked invalid", async () => {
    const harness = await seedStudy();
    const experiment = acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "candidate with a moved worktree head",
        gitSha: "5".repeat(40),
      }),
    );
    await writeMetrics(harness, experiment.sequence, {
      ...metricsPayload(),
      status: "invalid",
      invalidReason: "worktree_head_moved",
      plausibilityFailures: ["worktree HEAD moved during the run"],
    });

    const settled = await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId: null,
      outcome: "succeeded",
    });
    expect(settled.settled).toBe(true);
    expect(settled.metricsRejection).toContain("worktree_head_moved");
    expect(settled.experiment?.status).toBe("crashed");
    expect(settled.experiment?.valBpb).toBeNull();
  });

  it("links a settled experiment to its heartbeat run", async () => {
    const harness = await seedStudy();
    const runId = await seedHeartbeatRun(harness);
    acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "candidate with a run row",
        gitSha: "6".repeat(40),
      }),
    );

    const settled = await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId,
      outcome: "succeeded",
    });
    expect(settled.settled).toBe(true);
    expect(settled.experiment?.heartbeatRunId).toBe(runId);
  });

  it("keeps an improvement and advances the branch", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0, noiseFloorBpb: 0.01 });
    const { verdict } = await runExperiment(harness, {
      description: "better rotary schedule",
      valBpb: 0.97,
      gitSha: "7".repeat(40),
    });
    expect(verdict?.decision.verdict).toBe("keep");
    expect(verdict?.decision.verdictReason).toBe("val_bpb_improved");
    expect(verdict?.decision.gitAction).toBe("advanced");
    expect(verdict?.decision.updatesBest).toBe(true);
    expect(verdict?.decision.metricCredit).toBe(true);
    expect(verdict?.bestValBpb).toBeCloseTo(0.97, 10);
    expect(verdict?.experiment.status).toBe("kept");
    expect(verdict?.verdictRow.previousBestValBpb).toBeCloseTo(1.0, 10);
    expect(verdict?.verdictRow.newBestValBpb).toBeCloseTo(0.97, 10);

    const study = await studyRow(harness.studyId);
    expect(study?.bestValBpb).toBeCloseTo(0.97, 10);
    expect(study?.bestExperimentId).toBe(verdict?.experiment.id);
    expect(study?.keepCount).toBe(1);
    expect(study?.lastKeptSha).toBe("7".repeat(40));
  });

  it("discards a regression and resets the branch", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0, noiseFloorBpb: 0.01 });
    const { verdict } = await runExperiment(harness, {
      description: "wider model",
      valBpb: 1.05,
      gitSha: "8".repeat(40),
    });
    expect(verdict?.decision.verdict).toBe("discard");
    expect(verdict?.decision.gitAction).toBe("reset_to_sha");
    expect(verdict?.decision.metricCredit).toBe(false);
    expect(verdict?.bestValBpb).toBeCloseTo(1.0, 10);
    expect(verdict?.experiment.status).toBe("discarded");

    const study = await studyRow(harness.studyId);
    expect(study?.bestValBpb).toBeCloseTo(1.0, 10);
    expect(study?.discardCount).toBe(1);
    expect(study?.consecutiveDiscards).toBe(1);
    // A discard must not move the branch, so lastKeptSha keeps naming the previous commit.
    expect(study?.lastKeptSha).toBe("b".repeat(40));
  });

  it("never resets a regression just because the code got simpler", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0, noiseFloorBpb: 0.01 });
    const { verdict } = await runExperiment(harness, {
      description: "simpler but worse",
      valBpb: 1.05,
      complexityDeltaLines: -120,
      gitSha: "9".repeat(40),
    });
    expect(verdict?.decision.verdict).toBe("discard");
    expect(verdict?.decision.gitAction).toBe("reset_to_sha");
    expect(verdict?.decision.simplificationKeep).toBe(false);
  });

  it("adopts a within-noise simplification win without moving bestValBpb", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0, noiseFloorBpb: 0.01 });
    const { verdict } = await runExperiment(harness, {
      description: "strip the unused second head",
      valBpb: 1.002,
      complexityDeltaLines: -84,
      gitSha: "a".repeat(40),
    });
    expect(verdict?.decision.verdict).toBe("keep");
    expect(verdict?.decision.verdictReason).toBe("simplification_win");
    expect(verdict?.decision.gitAction).toBe("adopt_simplification");
    // No metric credit and no new best: the score did not move, only the code got smaller.
    expect(verdict?.decision.metricCredit).toBe(false);
    expect(verdict?.decision.updatesBest).toBe(false);
    expect(verdict?.bestValBpb).toBeCloseTo(1.0, 10);
    expect(verdict?.experiment.metricCredit).toBe(false);

    const study = await studyRow(harness.studyId);
    // The branch does advance to the simpler commit.
    expect(study?.lastKeptSha).toBe("a".repeat(40));
    expect(study?.bestValBpb).toBeCloseTo(1.0, 10);
    expect(study?.keepCount).toBe(1);
  });

  it("never lets a crash become bestValBpb", async () => {
    const harness = await seedStudy({ bestValBpb: 0.5, noiseFloorBpb: 0.01 });
    const begun = acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "candidate that dies",
        gitSha: "b".repeat(40),
      }),
    );
    const settled = await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId: null,
      outcome: "timed_out",
      error: "killed past kill_after_sec",
    });
    expect(settled.experiment?.valBpb).toBeNull();

    const adjudicated = await harness.service.adjudicate({
      companyId: harness.companyId,
      experimentId: begun.id,
    });
    expect(adjudicated.decision.verdict).toBe("crash");
    expect(adjudicated.decision.verdictReason).toBe("val_bpb_regressed");
    expect(adjudicated.decision.updatesBest).toBe(false);
    expect(adjudicated.bestValBpb).toBeCloseTo(0.5, 10);

    const study = await studyRow(harness.studyId);
    expect(study?.bestValBpb).toBeCloseTo(0.5, 10);
    expect(study?.crashCount).toBe(1);
    expect(study?.consecutiveCrashes).toBe(1);
  });

  it("refuses to adjudicate twice", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0 });
    const { experiment } = await runExperiment(harness, {
      description: "candidate",
      valBpb: 0.98,
      gitSha: "c".repeat(40),
    });
    await expect(
      harness.service.adjudicate({
        companyId: harness.companyId,
        experimentId: experiment.id,
      }),
    ).rejects.toThrow(/already been adjudicated/i);
  });

  it("regenerates results.tsv with the upstream header and a crash row of 0.000000 / 0.0", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0, noiseFloorBpb: 0.01 });
    await runExperiment(harness, {
      description: "better rotary schedule",
      valBpb: 0.97,
      gitSha: "1111111111111111111111111111111111111111",
    });

    const crashed = acquired(
      await harness.service.beginExperiment({
        companyId: harness.companyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "dies on an OOM",
        gitSha: "2222222222222222222222222222222222222222",
      }),
    );
    await harness.service.settleFromRun({
      companyId: harness.companyId,
      studyId: harness.studyId,
      runId: null,
      outcome: "failed",
      error: "CUDA out of memory",
    });

    const content = await harness.service.regenerateResultsTsv(harness.companyId, harness.studyId);
    expect(content).not.toBeNull();
    const lines = (content as string).split("\n").filter((line) => line.length > 0);
    // Exactly the upstream five-column contract. Adding a column breaks the reader that has to
    // parse this file.
    expect(lines[0]).toBe("commit\tval_bpb\tmemory_gb\tstatus\tdescription");
    expect(lines[0]?.split("\t")).toHaveLength(5);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("1111111\t0.970000\t2.9\tkeep\tbetter rotary schedule");
    // The crash sentinel exists only in the rendered file. In the database valBpb stays NULL,
    // because 0.000000 sorts as the best possible score.
    expect(lines[2]).toBe("2222222\t0.000000\t0.0\tcrash\tdies on an OOM");
    // Re-read: `crashed` is the snapshot beginExperiment returned, captured before the settle.
    const persisted = await experimentRow(harness.studyId, crashed.id);
    expect(persisted?.status).toBe("crashed");
    expect(persisted?.valBpb).toBeNull();

    expect(await readFile(harness.resultsTsv, "utf8")).toBe(content);
  });

  it("does not render an unadjudicated successful run as a verdict", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0, noiseFloorBpb: 0.01 });
    const { experiment } = await runExperiment(harness, {
      description: "settled but not judged",
      valBpb: 0.99,
      gitSha: "3333333333333333333333333333333333333333",
      adjudicate: false,
    });
    expect(experiment.status).toBe("succeeded");

    const content = (await harness.service.regenerateResultsTsv(
      harness.companyId,
      harness.studyId,
    )) as string;
    // Header only: publishing `keep` here would record a verdict the framework has not made.
    expect(content.split("\n").filter((line) => line.length > 0)).toEqual([
      "commit\tval_bpb\tmemory_gb\tstatus\tdescription",
    ]);

    await harness.service.adjudicate({
      companyId: harness.companyId,
      experimentId: experiment.id,
    });
    const after = (await harness.service.regenerateResultsTsv(
      harness.companyId,
      harness.studyId,
    )) as string;
    expect(after.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("reports the leaderboard and progress views with the best experiment badged", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0, noiseFloorBpb: 0.01 });
    const { verdict } = await runExperiment(harness, {
      description: "better rotary schedule",
      valBpb: 0.97,
      gitSha: "dddddddddddddddddddddddddddddddddddddddd",
    });

    const board = await harness.service.leaderboard(harness.companyId, harness.studyId);
    expect(board).toHaveLength(1);
    expect(board[0]?.isCurrentBest).toBe(true);
    expect(board[0]?.isBranchHead).toBe(true);
    expect(board[0]?.valBpb).toBeCloseTo(0.97, 10);
    expect(board[0]?.verdict).toBe("keep");
    expect(board[0]?.memoryGb).toBeCloseTo(2.9, 5);
    expect(board[0]?.experimentId).toBe(verdict?.experiment.id);

    const points = await harness.service.progress(harness.companyId, harness.studyId);
    expect(points).toHaveLength(1);
    expect(points[0]?.isBest).toBe(true);
    expect(points[0]?.sequence).toBe(1);
    expect(points[0]?.verdict).toBe("keep");
  });

  it("writes an activity log entry for every experiment mutation", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0, noiseFloorBpb: 0.01 });
    const { experiment } = await runExperiment(harness, {
      description: "better rotary schedule",
      valBpb: 0.97,
      gitSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });

    const rows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, harness.companyId),
          eq(activityLog.entityId, experiment.id),
        ),
      );
    const actions = rows.map((row) => row.action);
    expect(actions).toContain("study.experiment_started");
    expect(actions).toContain("study.experiment_settled");
    expect(actions).toContain("study.experiment_adjudicated");
  });

  it("scopes every read and write to the owning company", async () => {
    const harness = await seedStudy({ bestValBpb: 1.0, noiseFloorBpb: 0.01 });
    const { verdict } = await runExperiment(harness, {
      description: "candidate",
      valBpb: 0.97,
      gitSha: "ffffffffffffffffffffffffffffffffffffffff",
    });

    const otherCompanyId = randomUUID();
    await expect(
      harness.service.getExperiment(otherCompanyId, verdict?.experiment.id ?? ""),
    ).rejects.toThrow(/not found/i);
    await expect(
      harness.service.beginExperiment({
        companyId: otherCompanyId,
        studyId: harness.studyId,
        kind: "hypothesis",
        description: "cross-company",
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      harness.service.regenerateResultsTsv(otherCompanyId, harness.studyId),
    ).rejects.toThrow(/not found/i);
    await expect(
      harness.service.reconcileOrphans(otherCompanyId, harness.studyId, { killAfterSec: 900 }),
    ).rejects.toThrow(/not found/i);
  });
});
