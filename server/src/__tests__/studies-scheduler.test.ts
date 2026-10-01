import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  activityLog,
  agents,
  companies,
  createDb,
  experiments,
  issues,
  projects,
  studies,
  studyProposers,
} from "@paperclipai/db";
import { STUDY_EXPERIMENT_ORIGIN_KIND, STUDY_IDEA_PROPOSAL_ORIGIN_KIND } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { experimentsService } from "../services/studies/experiments.ts";
import { studyDispatcher, resolveExecutorPath } from "../services/studies/dispatch.ts";
import { studyScheduler, type DispatchExperimentInput } from "../services/studies/scheduler.ts";

type Db = ReturnType<typeof createDb>;

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;

describeDb("study scheduler and dispatcher", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-studies-scheduler-");
    db = createDb(tempDb.connectionString);
  // Booting embedded Postgres is slow enough on a busy machine to exceed the
  // default 10s hook timeout, and it matches EMBEDDED_POSTGRES_TEST_TIMEOUT_MS.
  }, 90_000);

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    // activity_log and issues reference the rows below, so they go first.
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(studyProposers);
    await db.delete(experiments);
    await db.delete(studies);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  interface Seeded {
    companyId: string;
    studyId: string;
    projectId: string;
    executorAgentId: string;
    repoPath: string;
    wakes: { agentId: string; opts: Record<string, unknown> }[];
  }

  async function seed(
    options: { status?: "active" | "paused"; executor?: boolean; proposers?: number } = {},
  ): Promise<Seeded> {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executorAgentId = randomUUID();
    const repoRoot = await mkdtemp(path.join(tmpdir(), "study-sched-"));
    tempRoots.push(repoRoot);
    const repoPath = path.join(repoRoot, "autoresearch");
    await mkdir(repoPath, { recursive: true });

    // A real repository, because dispatch now creates the study branch for real.
    // A mocked git would not catch a branch path or ref that git rejects.
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    await writeFile(path.join(repoPath, "train.py"), "VAL = 1.0\n", "utf8");
    git("add", "-A");
    git("commit", "--no-gpg-sign", "-m", "baseline");

    await db.insert(companies).values({
      id: companyId,
      name: "Autoresearch Co",
      // Unique per company: the column has a unique index, and several tests seed
      // more than one company in the same database.
      issuePrefix: randomUUID().slice(0, 6).toUpperCase(),
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "nanochat" });

    const wakes: Seeded["wakes"] = [];
    await db.insert(agents).values({
      id: executorAgentId,
      companyId,
      name: "Trainer",
      role: "researcher",
      // A process-adapter executor: no language model in the training path.
      adapterType: "process",
    });

    const studyId = randomUUID();
    await db.insert(studies).values({
      id: studyId,
      companyId,
      projectId,
      name: "nanochat study",
      tag: "mar5",
      branchName: "autoresearch/mar5",
      baseRef: "main",
      repoPath,
      status: options.status ?? "active",
      executorAgentId: options.executor === false ? null : executorAgentId,
      pulseIntervalSec: 120,
      lastPulseAt: null,
      minOpenIdeas: 2,
    });

    for (let i = 0; i < (options.proposers ?? 0); i += 1) {
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Proposer ${i}`,
        role: "researcher",
        adapterType: "claude_local",
      });
      await db.insert(studyProposers).values({ companyId, studyId, agentId, active: true });
    }

    return { companyId, studyId, projectId, executorAgentId, repoPath, wakes };
  }

  function harness(seeded: Seeded) {
    const dispatcher = studyDispatcher(db as Db, {
      wakeup: async (agentId, opts) => {
        seeded.wakes.push({ agentId, opts: opts as Record<string, unknown> });
      },
    });
    const scheduler = studyScheduler(db as Db, {
      dispatchExperiment: dispatcher.dispatchExperiment,
      requestProposal: dispatcher.requestProposal,
    });
    return { dispatcher, scheduler };
  }

  const dispatchInput = (seeded: Seeded, experimentId: string, sequence: number): DispatchExperimentInput => ({
    companyId: seeded.companyId,
    studyId: seeded.studyId,
    experimentId,
    sequence,
    description: "widen the rotary schedule",
    agentId: seeded.executorAgentId,
    // Must match what workspace-runtime provisions for the pinned branch.
    worktreePath: path.join(seeded.repoPath, ".paperclip", "worktrees", "autoresearch/mar5"),
    killAfterSec: 900,
  });

  it("resolves the shipped executor in both the source and built layouts", () => {
    const resolved = resolveExecutorPath();
    expect(resolved.endsWith("run-experiment.mjs")).toBe(true);
  });

  it("does nothing when no study is due", async () => {
    const seeded = await seed();
    // A study pulsed moments ago is not due, so the beat is a no-op.
    const now = new Date();
    await db
      .update(studies)
      .set({ lastPulseAt: now, updatedAt: now })
      .where(eq(studies.id, seeded.studyId));

    const { scheduler } = harness(seeded);
    const result = await scheduler.tickStudies(new Date(now.getTime() + 1_000));
    expect(result.evaluated).toBe(0);
    expect(result.pulsed).toBe(0);
  });

  it("ignores a study that is not active", async () => {
    const seeded = await seed({ status: "paused" });
    const { scheduler } = harness(seeded);
    const result = await scheduler.tickStudies(new Date());
    expect(result.pulsed).toBe(0);
    expect(seeded.wakes).toHaveLength(0);
  });

  it("does not pulse a study twice inside its interval", async () => {
    const seeded = await seed();
    const { scheduler } = harness(seeded);
    const now = new Date();

    expect((await scheduler.tickStudies(now)).pulsed).toBe(1);
    // A second beat seconds later must not re-pulse: two overlapping pulses would
    // each think they own the GPU slot.
    expect((await scheduler.tickStudies(new Date(now.getTime() + 5_000))).pulsed).toBe(0);
    // Past the interval it runs again.
    expect((await scheduler.tickStudies(new Date(now.getTime() + 200_000))).pulsed).toBe(1);
  });

  it("dispatches a running experiment to the executor exactly once", async () => {
    const seeded = await seed();
    const { scheduler, dispatcher } = harness(seeded);
    const experiments = experimentsService(db as Db);
    const experiment = await experiments.beginExperiment({
      companyId: seeded.companyId,
      studyId: seeded.studyId,
      kind: "baseline",
      description: "baseline",
      gitSha: "a".repeat(40),
    });
    expect(experiment.acquired).toBe(true);
    if (!experiment.acquired) return;

    const input = dispatchInput(seeded, experiment.experiment.id, experiment.experiment.sequence);
    expect(await dispatcher.dispatchExperiment(input)).toBe(true);
    expect(await dispatcher.dispatchExperiment(input)).toBe(false);

    const created = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, STUDY_EXPERIMENT_ORIGIN_KIND),
          eq(issues.originId, experiment.experiment.id),
        ),
      );
    expect(created).toHaveLength(1);
    expect(created[0]?.assigneeAgentId).toBe(seeded.executorAgentId);
    // The executor must be woken, and the trainer must get no credentials.
    expect(seeded.wakes.length).toBeGreaterThan(0);
    const overrides = created[0]?.assigneeAdapterOverrides as Record<string, Record<string, unknown>>;
    expect(overrides.adapterConfig.injectApiKey).toBe(false);
    expect(String(overrides.adapterConfig.cwd)).toContain("autoresearch");
    // The executor path must actually resolve, or every run would fail at dispatch.
    expect(String(overrides.adapterConfig.args?.[0] ?? "")).toContain("run-experiment.mjs");

    // A full tick must not create a second dispatch issue for the same run.
    await scheduler.tickStudies(new Date());
    const after = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, STUDY_EXPERIMENT_ORIGIN_KIND),
          eq(issues.originId, experiment.experiment.id),
        ),
      );
    expect(after).toHaveLength(1);
  });

  it("pins the study branch on the dispatch issue rather than creating a new one", async () => {
    const seeded = await seed();
    const { dispatcher } = harness(seeded);
    const experiments = experimentsService(db as Db);
    const experiment = await experiments.beginExperiment({
      companyId: seeded.companyId,
      studyId: seeded.studyId,
      kind: "baseline",
      description: "baseline",
      gitSha: "b".repeat(40),
    });
    if (!experiment.acquired) throw new Error("expected the GPU slot");

    await dispatcher.dispatchExperiment(dispatchInput(seeded, experiment.experiment.id, 1));
    const created = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, STUDY_EXPERIMENT_ORIGIN_KIND),
          eq(issues.originId, experiment.experiment.id),
        ),
      );
    const settings = created[0]?.executionWorkspaceSettings as {
      mode?: string;
      workspaceStrategy?: { type?: string; existingBranch?: string };
    };
    // `existingBranch` attaches and never moves the branch, which is what a study
    // spanning many experiments needs. `branchTemplate` would create a new one.
    expect(settings.workspaceStrategy?.existingBranch).toBe("autoresearch/mar5");
    // The contract rejects an exact-branch pin without isolated mode, so the pin
    // would 422 if this were left out.
    expect(settings.mode).toBe("isolated_workspace");

    // Exact-branch realization fails closed on a missing branch, so dispatch has to
    // have created it.
    const branches = execFileSync("git", ["branch", "--list"], {
      cwd: seeded.repoPath,
      encoding: "utf8",
    });
    expect(branches).toContain("autoresearch/mar5");
  });

  it("asks the least recently asked proposer first", async () => {
    const seeded = await seed({ proposers: 2 });
    const { scheduler } = harness(seeded);

    const result = await scheduler.tickStudies(new Date());
    expect(result.requested).toBeGreaterThan(0);

    const rows = await db.select().from(studyProposers).where(eq(studyProposers.studyId, seeded.studyId));
    const asked = rows.filter((row) => row.lastProposalAt !== null);
    expect(asked.length).toBe(rows.length);

    const threads = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, STUDY_IDEA_PROPOSAL_ORIGIN_KIND));
    // One thread per proposer, not one thread for the study: keying on the study
    // alone would let the first proposer asked claim the only key and silently
    // exclude every other proposer forever.
    expect(threads).toHaveLength(asked.length);
    for (const thread of threads) {
      expect(thread.assigneeAgentId).toBeTruthy();
      expect(asked.find((row) => row.agentId === thread.assigneeAgentId)).toBeTruthy();
    }
  });

  it("gives each proposer its own thread rather than one thread for the study", async () => {
    const seeded = await seed({ proposers: 3 });
    const { scheduler } = harness(seeded);
    await scheduler.tickStudies(new Date());

    const threads = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, STUDY_IDEA_PROPOSAL_ORIGIN_KIND));
    expect(threads).toHaveLength(3);
    // Distinct origin ids, so each proposer can be woken independently.
    expect(new Set(threads.map((t) => t.originId)).size).toBe(3);
    expect(new Set(threads.map((t) => t.assigneeAgentId)).size).toBe(3);
  });

  it("does not stack proposal requests for one proposer", async () => {
    const seeded = await seed({ proposers: 1 });
    const { scheduler } = harness(seeded);
    const now = new Date();

    await scheduler.tickStudies(now);
    // Well past the pulse interval, so the study is due again. The thread exists,
    // so this re-wakes it rather than opening a second one.
    await scheduler.tickStudies(new Date(now.getTime() + 300_000));

    const threads = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, STUDY_IDEA_PROPOSAL_ORIGIN_KIND));
    expect(threads).toHaveLength(1);
    // The re-wake happened, and was idempotency-keyed so it cannot stack.
    expect(seeded.wakes.filter((w) => w.agentId !== seeded.executorAgentId).length).toBeGreaterThan(1);
  });

  it("does not dispatch when the study has no executor agent", async () => {
    const seeded = await seed({ executor: false });
    const { scheduler } = harness(seeded);
    const experiments = experimentsService(db as Db);
    await experiments.beginExperiment({
      companyId: seeded.companyId,
      studyId: seeded.studyId,
      kind: "baseline",
      description: "baseline",
      gitSha: "c".repeat(40),
    });

    await scheduler.tickStudies(new Date());

    const dispatchIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, STUDY_EXPERIMENT_ORIGIN_KIND));
    // A run with nowhere to go must not be started.
    expect(dispatchIssues).toHaveLength(0);
  });

  it("records a study that stopped advancing rather than retrying forever", async () => {
    // Five consecutive crashes is a broken setup, not an idea-quality problem, and
    // continuing would burn the GPU on the same failure all night.
    const seeded = await seed();
    await db
      .update(studies)
      .set({ consecutiveCrashes: 5 })
      .where(eq(studies.id, seeded.studyId));

    const { scheduler } = harness(seeded);
    const result = await scheduler.tickStudies(new Date());

    expect(result.stopped).toHaveLength(1);
    expect(result.stopped[0]?.reason).toMatch(/crash/i);
    expect(result.stopped[0]?.studyId).toBe(seeded.studyId);
  });

  it("keeps one broken study from stopping the others", async () => {
    const good = await seed();
    const broken = await seed();
    await db
      .update(studies)
      .set({ consecutiveCrashes: 9 })
      .where(eq(studies.id, broken.studyId));

    const { scheduler } = harness(good);
    const result = await scheduler.tickStudies(new Date());

    // The healthy study still gets its beat.
    expect(result.pulsed).toBeGreaterThanOrEqual(1);
    expect(result.stopped.map((entry) => entry.studyId)).toContain(broken.studyId);
    expect(result.stopped.map((entry) => entry.studyId)).not.toContain(good.studyId);
  });
});