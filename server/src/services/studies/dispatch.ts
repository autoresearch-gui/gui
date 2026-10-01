import { and, eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "@paperclipai/db";
import { experiments, issues, studies } from "@paperclipai/db";
import {
  STUDY_EXPERIMENT_ORIGIN_KIND,
  STUDY_IDEA_PROPOSAL_ORIGIN_KIND,
} from "@paperclipai/shared";

import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import type {
  DispatchExperimentInput,
  RequestProposalInput,
} from "./scheduler.js";
import { studyPaths } from "./paths.js";
import { ensureStudyBranch, runGit } from "./branch.js";

/**
 * Locates the shipped executor script.
 *
 * It is a `.mjs` asset that the server build copies into `dist/services/scripts`,
 * not a compiled module, so it has to be resolved as a path in both layouts
 * rather than imported. Falling back through both is what keeps a source checkout
 * and a published package working with the same dispatch code.
 */
export function resolveExecutorPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // The executor sits in `services/scripts`, a sibling of `services/studies`, in
  // both layouts: `src/services/scripts` when running from source and
  // `dist/services/scripts` after a build. So one `..` covers both, and the
  // package root is the fallback for a bundled publish where this file is at the
  // top level.
  const candidates = [
    path.resolve(here, "..", "scripts", "run-experiment.mjs"),
    path.resolve(here, "..", "..", "scripts", "run-experiment.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `run-experiment.mjs was not found. Looked in: ${candidates.join(", ")}`,
  );
}

/**
 * Turns scheduler decisions into issues that wake agents.
 *
 * The pulse decides what should happen; this decides how an agent finds out. Both
 * directions are idempotent, keyed on `originId`, because a pulse can fire twice
 * for the same work - a retry, a second server instance, a slow beat that
 * overlaps the next one - and a study must never put one training run on the GPU
 * twice or ask one proposer for the same idea twice.
 */
export interface DispatchDeps {
  /** The heartbeat service's `wakeup`, for queueing an agent run. */
  wakeup?: (agentId: string, opts: DispatchWakeOptions) => Promise<unknown>;
}

interface DispatchWakeOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

export function studyDispatcher(db: Db, deps: DispatchDeps = {}) {
  /**
   * One long-lived conversation per proposer, so the key includes the proposer.
   *
   * Keying on the study alone would let the first proposer to be asked claim the
   * only key, and every other proposer would then be silently skipped forever.
   */
  function proposalOriginId(studyId: string, proposerAgentId: string): string {
    return `${studyId}:${proposerAgentId}`;
  }

  /**
   * Finds a dispatch issue for this exact key.
   *
   * Deliberately status-blind. The point of the key is "this work has had a
   * thread"; a closed thread still means the history exists, and reopening it is
   * better than a second thread pointing an agent at work it already did.
   */
  async function findByOrigin(companyId: string, originKind: string, originId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
        ),
      )
      .orderBy(issues.createdAt)
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Creates the issue that runs one training experiment, and wakes the executor.
   *
   * The executor is a `process`-adapter agent, so the run costs no tokens and
   * behaves identically every time. The per-experiment `cwd` and `argv` ride on
   * the issue's adapter overrides rather than the agent, because they differ per
   * experiment while the agent itself is long-lived.
   *
   * The issue also carries the executor's measured argv, so the replay verifier
   * and the human reading the run log both see what was actually executed.
   */
  async function dispatchExperiment(input: DispatchExperimentInput): Promise<boolean> {
    const existing = await findByOrigin(
      input.companyId,
      STUDY_EXPERIMENT_ORIGIN_KIND,
      input.experimentId,
    );
    if (existing) {
      // Already dispatched. Re-wake rather than create: the run may have been
      // cancelled and need redoing, and a duplicate issue would only confuse the
      // ledger by pointing a second thread at the same experiment.
      await deps.wakeup?.(existing.assigneeAgentId ?? input.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "study_experiment_redispatch",
        payload: { issueId: existing.id, experimentId: input.experimentId },
        // One live run per experiment, so a repeated wake must not stack.
        idempotencyKey: `study-experiment:${input.experimentId}`,
        requestedByActorType: "system",
        requestedByActorId: "study_scheduler",
        contextSnapshot: { issueId: existing.id, source: "study_scheduler" },
      });
      return false;
    }

    const study = await db
      .select()
      .from(studies)
      .where(and(eq(studies.companyId, input.companyId), eq(studies.id, input.studyId)))
      .then((rows) => rows[0] ?? null);
    if (!study) return false;

    const paths = studyPaths(study);
    const experiment = await db
      .select({ sequence: experiments.sequence, gitSha: experiments.gitSha })
      .from(experiments)
      .where(
        and(
          eq(experiments.companyId, input.companyId),
          eq(experiments.id, input.experimentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!experiment) return false;

    const metricsPath = `${paths.metricsDir}/${experiment.sequence}.json`;
    const logPath = `${paths.logDir}/${experiment.sequence}.log`;

    // The pinned workspace below attaches by exact branch name and fails closed
    // if that branch is missing, so the framework creates it first. Idempotent,
    // and it never moves an existing branch.
    await ensureStudyBranch(runGit, {
      repoPath: study.repoPath,
      branchName: study.branchName,
      baseRef: study.baseRef,
    }).catch((error: unknown) => {
      // Refuse to dispatch rather than queue a run that cannot start: an
      // unreachable branch here would show up as a crash twelve minutes later,
      // long after the cause.
      throw new Error(
        `could not prepare study branch ${study.branchName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    // The executor owns the wall-clock kill from spawn, so the adapter's timeout is
    // only the outer backstop on the executor process itself and must exceed it.
    const executorArgs = [
      resolveExecutorPath(),
      "--worktree",
      input.worktreePath,
      "--seq",
      String(experiment.sequence),
      "--out",
      metricsPath,
      "--log",
      logPath,
      "--kill-after",
      String(input.killAfterSec),
    ];

    const created = await db
      .insert(issues)
      .values({
        companyId: input.companyId,
        projectId: study.projectId,
        title: `Run experiment #${experiment.sequence}`,
        description: [
          `Execute the autoresearch training run for experiment #${experiment.sequence}.`,
          "",
          `Idea: ${input.description}`,
          `Commit: ${experiment.gitSha ?? "unknown"}`,
          `Branch: ${study.branchName}`,
          "",
          "Run it with the shipped executor. It owns the wall-clock kill, parses and",
          "validates the metrics block, and records what happened. Do not run",
          "`uv run train.py` by hand: a hand-run produces a metric the framework",
          "cannot attribute to this experiment.",
          "",
          `Worktree: ${input.worktreePath}`,
          `Metrics: ${metricsPath}`,
          `Log: ${logPath}`,
        ].join("\n"),
        status: "todo",
        priority: "high",
        assigneeAgentId: input.agentId,
        originKind: STUDY_EXPERIMENT_ORIGIN_KIND,
        originId: input.experimentId,
        originFingerprint: `study-experiment-${experiment.sequence}`,
        executionWorkspaceSettings: {
          // Pins the long-lived study branch worktree. `existingBranch` attaches
          // and never creates, and never moves it, which is exactly what a
          // multi-experiment study needs. The contract requires `isolated_workspace`
          // alongside it, and rightly so: an exact-branch pin in a shared checkout
          // would let a study mutate the primary workspace.
          mode: "isolated_workspace",
          workspaceStrategy: {
            type: "git_worktree",
            existingBranch: study.branchName,
            baseRef: study.baseRef,
          },
        },
        // Per-experiment, because the worktree, metrics, and log paths differ each
        // time while the executor agent is long-lived.
        assigneeAdapterOverrides: {
          adapterConfig: {
            // Absolute: the process adapter falls back to the SERVER's cwd when
            // `cwd` is missing, which would train the wrong tree entirely.
            cwd: input.worktreePath,
            command: process.execPath,
            args: executorArgs,
            timeoutSec: input.killAfterSec + 60,
            graceSec: 20,
            // The trainer is agent-written Python. It gets no company credentials:
            // no agent JWT and no runtime-tools token.
            injectApiKey: false,
          },
        },
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!created) return false;

    // The experiment owns the run from here; the heartbeat settle hook resolves it
    // back through heartbeatRunId.
    await db
      .update(experiments)
      .set({ issueId: created.id })
      .where(
        and(eq(experiments.companyId, input.companyId), eq(experiments.id, input.experimentId)),
      );

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "study_scheduler",
      agentId: input.agentId,
      action: "study.experiment_dispatched",
      entityType: "experiment",
      entityId: input.experimentId,
      issueId: created.id,
      details: {
        studyId: input.studyId,
        sequence: experiment.sequence,
        worktreePath: input.worktreePath,
        metricsPath,
      },
    });

    await deps.wakeup?.(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "study_experiment_dispatched",
      payload: {
        issueId: created.id,
        experimentId: input.experimentId,
        studyId: input.studyId,
        sequence: experiment.sequence,
        // The heartbeat builds the turn from these, so this is how the executor
        // learns where to write. `issues` has no metadata column, and a comment
        // would be a worse place for machine context.
        worktreePath: input.worktreePath,
        metricsPath,
        logPath,
        killAfterSec: input.killAfterSec,
      },
      // One live run per experiment. A repeated pulse cannot stack runs.
      idempotencyKey: `study-experiment:${input.experimentId}`,
      requestedByActorType: "system",
      requestedByActorId: "study_scheduler",
      contextSnapshot: {
        issueId: created.id,
        source: "study_scheduler",
        studyId: input.studyId,
        experimentId: input.experimentId,
        worktreePath: input.worktreePath,
        metricsPath,
        logPath,
      },
    });

    logger.info(
      { studyId: input.studyId, experimentId: input.experimentId, issueId: created.id },
      "dispatched study experiment to the executor",
    );
    return true;
  }

  /**
   * Creates or re-wakes the issue that asks one proposer for an idea.
   *
   * Deliberately one long-lived issue per proposer rather than one per idea: the
   * proposer's value is a running conversation with the research history, and a
   * fresh thread each cycle would discard exactly the context that makes a
   * proposal informed. The history lives in the study, and the thread refers to
   * it.
   */
  async function requestProposal(input: RequestProposalInput): Promise<boolean> {
    const originId = proposalOriginId(input.studyId, input.proposerAgentId);
    const existing = await findByOrigin(
      input.companyId,
      STUDY_IDEA_PROPOSAL_ORIGIN_KIND,
      originId,
    );
    if (existing) {
      await deps.wakeup?.(input.proposerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "study_idea_proposal_requested",
        payload: {
          issueId: existing.id,
          studyId: input.studyId,
          openIdeas: input.openIdeas,
          minOpenIdeas: input.minOpenIdeas,
        },
        // One live turn per proposer, so a fast pulse cannot queue a pile-up.
        idempotencyKey: `study-idea:${input.studyId}:${input.proposerAgentId}`,
        requestedByActorType: "system",
        requestedByActorId: "study_scheduler",
        contextSnapshot: { issueId: existing.id, source: "study_scheduler" },
      });
      return false;
    }

    const study = await db
      .select({ tag: studies.tag, branchName: studies.branchName })
      .from(studies)
      .where(and(eq(studies.companyId, input.companyId), eq(studies.id, input.studyId)))
      .then((rows) => rows[0] ?? null);
    if (!study) return false;

    const created = await db
      .insert(issues)
      .values({
        companyId: input.companyId,
        title: `Propose an experiment for study ${study.tag}`,
        description: [
          `The study has ${input.openIdeas} of ${input.minOpenIdeas} ideas shortlisted.`,
          "",
          "Read the study protocol and the experiment history, then submit ONE idea:",
          "a hypothesis, the reasoning behind it, and a unified diff to train.py.",
          "",
          "Submit it through the study API rather than only describing it. An idea",
          "that never reaches the ledger will never run, however good it is.",
          "",
          "Judge the idea on whether it is worth an eleven-minute GPU run, not on",
          "whether it is likely to win. Roughly every fourth experiment is drawn",
          "without regard to predicted gain, so a radical idea is genuinely useful",
          "here even when you rate it unlikely.",
          "",
          "Aim for the smallest change that tests one thing. A simplification that",
          "keeps the metric is worth more than a large change that improves it.",
        ].join("\n"),
        status: "todo",
        assigneeAgentId: input.proposerAgentId,
        originKind: STUDY_IDEA_PROPOSAL_ORIGIN_KIND,
        originId,
        originFingerprint: `study-idea-${input.proposerAgentId}`,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!created) return false;

    await deps.wakeup?.(input.proposerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "study_idea_proposal_requested",
      payload: { issueId: created.id, studyId: input.studyId },
      idempotencyKey: `study-idea:${input.studyId}:${input.proposerAgentId}`,
      requestedByActorType: "system",
      requestedByActorId: "study_scheduler",
      contextSnapshot: { issueId: created.id, source: "study_scheduler", studyId: input.studyId },
    });

    return true;
  }

  return { dispatchExperiment, requestProposal };
}