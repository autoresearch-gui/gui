import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql, sum } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, experimentIdeas, experimentVerdicts, experiments, studies } from "@paperclipai/db";
import type {
  ExperimentKind,
  ExperimentStatus,
  ExperimentVerdict,
  ExperimentVerdictReason,
  StudyGpuProfile,
  StudyLeaderboardRow,
  StudyProgressPoint,
} from "@paperclipai/shared";
import { isUniqueViolation } from "../../db-errors.js";
import { conflict, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { renderResultsTsv, writeResultsTsvAtomic, type TsvExperimentRow } from "./metrics.js";
import { studyMetricsFile, studyPaths } from "./paths.js";
import { resolveVerdict, type VerdictDecision } from "./verdict.js";

/**
 * Experiment lifecycle and adjudication for one study.
 *
 * The organizing rule for every method here: the LLM proposes, the framework executes and
 * adjudicates. No model call happens in this file, and every verdict has to be reproducible
 * from the durable record alone.
 */

/**
 * The partial unique index that allows at most one `running` experiment per study.
 *
 * A violation of THIS index is the only signal that another experiment already holds the
 * GPU. Application logic must never predict it with a read-then-write check, because two
 * callers can both observe "nothing is running" and both insert.
 */
export const SINGLE_RUNNING_INDEX = "experiments_single_running_per_study";

export const SEQUENCE_UNIQUE_INDEX = "experiments_study_sequence_uq";

/**
 * How many trailing experiments form the rolling simplification window.
 *
 * `maxSimplificationKeepsPerWindow` is enforced over this window. Measured over the whole
 * study it degenerates into a lifetime cap that stops mattering after a hundred
 * experiments; with no window at all it is not a cap, because an agent with an unlimited
 * simplification keep can always strip the model down to nothing while the score rots
 * inside the noise band.
 */
export const SIMPLIFICATION_WINDOW_SIZE = 5;

/**
 * Slack added on top of `killAfterSec + graceSec` before an orphaned `running` row is
 * declared crashed.
 *
 * The trainer is killed at killAfterSec, after which the adapter still has to unwind, flush
 * the redirected log, and let the executor's atomic metrics write land. Without slack,
 * reconciliation can win that race and stamp a live experiment as crashed.
 */
export const ORPHAN_RECONCILE_SLACK_SECONDS = 120;

export const ERROR_EXCERPT_MAX_CHARS = 2000;

export type ExperimentRow = typeof experiments.$inferSelect;
export type StudyRow = typeof studies.$inferSelect;
type VerdictRow = typeof experimentVerdicts.$inferSelect;

/** Terminal statuses. The GPU is free and the row may be adjudicated. */
const SETTLED_STATUSES = new Set<string>(["succeeded", "crashed", "timed_out"]);

/** Which terminal status a run outcome lands in. */
const OUTCOME_TO_STATUS: Record<SettleOutcome, ExperimentStatus> = {
  succeeded: "succeeded",
  failed: "crashed",
  timed_out: "timed_out",
  cancelled: "crashed",
};

/** Verdict -> the terminal experiment status it lands in. */
const VERDICT_TO_STATUS: Record<ExperimentVerdict, ExperimentStatus> = {
  keep: "kept",
  discard: "discarded",
  crash: "crashed",
};

/**
 * Terminal experiment status -> the upstream `results.tsv` status column.
 *
 * Upstream fixes that column to keep|discard|crash, so an experiment that has settled but
 * not yet been adjudicated still needs a value. A run that crashed or timed out maps to
 * `crash`; a run that produced a metric but has not been judged is deliberately NOT
 * rendered, because writing `keep` would publish a verdict the framework has not made.
 */
const TERMINAL_TSV_VERDICT: Partial<Record<ExperimentStatus, ExperimentVerdict>> = {
  crashed: "crash",
  timed_out: "crash",
  kept: "keep",
  discarded: "discard",
};

export interface StudyActor {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

export interface ExperimentsServiceDeps {
  /** Injected clock so orphan reconciliation is testable without sleeping. */
  now?: () => Date;
  /** Injected reader for the executor's metrics JSON. Defaults to a sync file read. */
  readMetricsJson?: (metricsFilePath: string) => Record<string, unknown> | null;
  /** Injected results writer. Defaults to the atomic write-then-rename helper. */
  writeResultsTsv?: (filePath: string, content: string) => void;
  /** Injected directory provisioner. Defaults to a recursive mkdir. */
  ensureDir?: (dirPath: string) => void;
}

export interface BeginExperimentInput {
  companyId: string;
  studyId: string;
  kind: ExperimentKind;
  description: string;
  hypothesis?: string | null;
  ideaId?: string | null;
  issueId?: string | null;
  gitSha?: string | null;
  /** Net line delta of the change. Negative means the model got simpler. */
  complexityDeltaLines?: number | null;
  /** True for the baseline characterization runs that measure the noise floor. */
  isBaseline?: boolean;
  actor?: StudyActor;
}

export type BeginExperimentResult = { acquired: true; experiment: ExperimentRow } | { acquired: false };

export type SettleOutcome = "succeeded" | "failed" | "timed_out" | "cancelled";

export interface SettleFromRunInput {
  companyId: string;
  studyId: string;
  /** The executor's heartbeat run. Null when the run was launched outside a run row. */
  runId: string | null;
  outcome: SettleOutcome;
  error?: string | null;
  actor?: StudyActor;
}

export interface SettleFromRunResult {
  /** False when the experiment was already terminal: settling twice is a no-op. */
  settled: boolean;
  experiment: ExperimentRow | null;
  /** Set when the run reported success but the executor's payload was not usable. */
  metricsRejection: string | null;
  /**
   * True when the run was killed by infrastructure and put back in `queued` for
   * another attempt rather than adjudicated. The idea is deliberately not
   * consumed, because nothing about it was tested.
   */
  requeued?: boolean;
}

export interface ReconcileOrphansOptions {
  /** The study's wall-clock kill, in seconds. */
  killAfterSec: number;
  /** Extra time a trainer is allowed past the kill before it counts as lost. */
  graceSec?: number;
  actor?: StudyActor;
}

export interface ReconcileOrphansResult {
  reconciled: number;
  experimentIds: string[];
}

export interface AdjudicateInput {
  companyId: string;
  experimentId: string;
  /** Overrides the stored value when supplied; otherwise the row's own value is used. */
  complexityDeltaLines?: number | null;
  /** Operator-imposed hard limit on val_bpb. Overrides every other rule. */
  valBpbCeiling?: number | null;
  /** Recorded on the audit row so a branch reset stays explainable. */
  reason?: string | null;
  /** sha the branch resets to when the verdict does not advance it. */
  targetSha?: string | null;
  actor?: StudyActor;
}

export interface AdjudicateResult {
  decision: VerdictDecision;
  experiment: ExperimentRow;
  verdictRow: VerdictRow;
  /** The study's best AFTER this verdict was applied. */
  bestValBpb: number | null;
  bestExperimentId: string | null;
}

const ORPHAN_ACTOR: StudyActor = { actorType: "system", actorId: "study_orphan_reconciler" };
const FRAMEWORK_ACTOR: StudyActor = { actorType: "system", actorId: "study_framework" };

function excerpt(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > ERROR_EXCERPT_MAX_CHARS ? trimmed.slice(0, ERROR_EXCERPT_MAX_CHARS) : trimmed;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalInteger(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric === null ? null : Math.trunc(numeric);
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Six decimals, matching the precision the executor actually prints. */
function roundDelta(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function readGpuTotalVramBytes(study: StudyRow): number | null {
  const profile = jsonRecord(study.gpuProfileJson) as Partial<StudyGpuProfile> | null;
  return finiteNumber(profile?.totalVramBytes);
}

function defaultReadMetricsJson(metricsFilePath: string): Record<string, unknown> | null {
  try {
    return jsonRecord(JSON.parse(readFileSync(metricsFilePath, "utf8")));
  } catch {
    // A missing or truncated file is the normal way a crash is detected, so this must be a
    // quiet null rather than a throw.
    return null;
  }
}

/**
 * Why the executor's own payload gets the last word on a "succeeded" run.
 *
 * `status: "succeeded"` is the executor's usability contract: exit code 0, a fully parsed
 * summary block, no `invalidReason`, and an empty plausibility failure list. Anything else
 * is written as `invalid` with the reason attached, and that reason names which
 * CANNOT-list rule, the worktree-head invariant, or the plausibility gate rejected the run.
 * Promoting such a run to a score would let a run whose own audit says "do not trust me"
 * become champion.
 */
function metricsRejection(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null;
  if (payload.status === "succeeded") {
    return finiteNumber(jsonRecord(payload.metrics)?.valBpb) === null
      ? "executor reported success but the metrics block has no finite val_bpb"
      : null;
  }
  const invalidReason = optionalText(payload.invalidReason) ?? "unspecified";
  const failures = Array.isArray(payload.plausibilityFailures)
    ? payload.plausibilityFailures.filter((failure): failure is string => typeof failure === "string")
    : [];
  const killedBy = optionalText(payload.killedBy);
  return [
    `executor metrics payload status ${optionalText(payload.status) ?? "unknown"} (${invalidReason})`,
    killedBy ? `killed by ${killedBy}` : null,
    failures.length > 0 ? failures.join("; ") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(": ");
}

export function experimentsService(db: Db, deps: ExperimentsServiceDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const readMetricsJson = deps.readMetricsJson ?? defaultReadMetricsJson;
  const writeResultsTsv = deps.writeResultsTsv ?? writeResultsTsvAtomic;
  const ensureDir = deps.ensureDir ?? ((dirPath: string) => void mkdirSync(dirPath, { recursive: true }));

  /**
   * Reads the executor's own verdict on why a run died.
   *
   * The executor sees the whole log and is the only component that can tell an
   * external kill from a genuine crash, so its classification is trusted rather
   * than re-derived here. Anything the executor did not write is treated as an
   * experiment failure: re-running on a guess risks looping a genuinely broken
   * setup all night, and `maxTransientRetries` bounds the damage either way.
   */
  function executorFailureClass(
    study: StudyRow,
    experiment: ExperimentRow,
  ): "infrastructure" | "experiment" | "unknown" {
    const metricsFile = studyMetricsFile(
      { repoPath: study.repoPath, tag: study.tag },
      experiment.sequence,
    );
    const payload = readMetricsJson(metricsFile);
    const classified = optionalText(jsonRecord(payload)?.failureClass);
    if (classified === "infrastructure" || classified === "experiment") return classified;
    return "unknown";
  }

  async function loadStudy(companyId: string, studyId: string): Promise<StudyRow> {
    const study = await db
      .select()
      .from(studies)
      .where(and(eq(studies.companyId, companyId), eq(studies.id, studyId)))
      .then((rows) => rows[0] ?? null);
    if (!study) throw notFound("Study not found");
    return study;
  }

  async function loadExperiment(companyId: string, experimentId: string): Promise<ExperimentRow> {
    const experiment = await db
      .select()
      .from(experiments)
      .where(and(eq(experiments.companyId, companyId), eq(experiments.id, experimentId)))
      .then((rows) => rows[0] ?? null);
    if (!experiment) throw notFound("Experiment not found");
    return experiment;
  }

  /**
   * Next 1-based sequence within a study.
   *
   * Read-then-insert alone collides on `experiments_study_sequence_uq` when two callers race,
   * so a unique violation there is handled the same way as losing the GPU: the caller falls
   * through to the next idea and retries on the next pulse. Queuing behind a number that may
   * already be taken buys nothing when the GPU is the throughput floor anyway.
   */
  async function nextSequence(studyId: string): Promise<number> {
    const row = await db
      .select({ maxSequence: sql<number | null>`max(${experiments.sequence})` })
      .from(experiments)
      .where(eq(experiments.studyId, studyId))
      .then((rows) => rows[0] ?? null);
    return (row?.maxSequence ?? 0) + 1;
  }

  async function beginExperiment(input: BeginExperimentInput): Promise<BeginExperimentResult> {
    const actor = input.actor ?? FRAMEWORK_ACTOR;
    // Loading the study binds companyId to studyId and yields the derived paths. It is NOT
    // the GPU check; the conditional INSERT below is.
    const study = await loadStudy(input.companyId, input.studyId);
    const paths = studyPaths({ repoPath: study.repoPath, tag: study.tag });
    const sequence = await nextSequence(input.studyId);
    const timestamp = now();

    let inserted: ExperimentRow | null;
    try {
      // `status: "running"` at INSERT time is what the partial unique index keys on, so the
      // insert itself is the arbitration. A violation means another experiment owns the
      // GPU, and the caller must fall through to the next idea rather than queue or
      // overwrite an existing run.
      inserted = await db
        .insert(experiments)
        .values({
          companyId: input.companyId,
          studyId: input.studyId,
          ideaId: input.ideaId ?? null,
          issueId: input.issueId ?? null,
          sequence,
          kind: input.kind,
          description: input.description,
          hypothesis: input.hypothesis ?? null,
          gitSha: input.gitSha ?? null,
          status: "running",
          autotuneCold: false,
          complexityDeltaLines: input.complexityDeltaLines ?? null,
          // The executor's redirected stdout+stderr for this sequence. The metrics file is
          // derived from the same sequence at settle time, so neither path is duplicated.
          logRef: `${paths.logDir}/${sequence}.log`,
          startedAt: timestamp,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
    } catch (error) {
      if (isUniqueViolation(error, SINGLE_RUNNING_INDEX)) return { acquired: false };
      if (isUniqueViolation(error, SEQUENCE_UNIQUE_INDEX)) {
        logger.warn(
          { studyId: input.studyId, sequence },
          "study experiment sequence collision; deferring to the next pulse",
        );
        return { acquired: false };
      }
      throw error;
    }
    if (!inserted) return { acquired: false };

    // The executor writes `<sequence>.json` into metrics/ and redirects into logs/. Both
    // directories live outside the worktree, so they are provisioned here, at the moment
    // the runner is about to be launched, rather than at study creation.
    ensureDir(paths.metricsDir);
    ensureDir(paths.logDir);

    await db
      .update(studies)
      .set({
        experimentCount: sql`${studies.experimentCount} + 1`,
        lastActivityAt: timestamp,
        updatedAt: timestamp,
      })
      .where(and(eq(studies.companyId, input.companyId), eq(studies.id, input.studyId)));

    if (input.ideaId) {
      // The idea has now been spent once. Counting here is what lets the crash backoff
      // refuse to burn the same idea forever.
      await db
        .update(experimentIdeas)
        .set({ attemptCount: sql`${experimentIdeas.attemptCount} + 1` })
        .where(
          and(eq(experimentIdeas.companyId, input.companyId), eq(experimentIdeas.id, input.ideaId)),
        );
    }

    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "study.experiment_started",
      entityType: "experiment",
      entityId: inserted.id,
      issueId: inserted.issueId,
      details: {
        studyId: input.studyId,
        sequence,
        kind: input.kind,
        ideaId: input.ideaId ?? null,
        gitSha: inserted.gitSha,
        isBaseline: input.isBaseline ?? false,
        logRef: inserted.logRef,
      },
    });

    return { acquired: true, experiment: inserted };
  }

  /**
   * Puts a requeued experiment back in `running` so the same row is retried.
   *
   * A requeued experiment keeps its sequence number, its idea, and its commit, so
   * the retry has to be the SAME row. Creating a fresh experiment instead would
   * consume a second sequence number and strand the requeued one in `queued`
   * forever, so the study would quietly stop testing the idea it had queued.
   *
   * Clears `finishedAt` and takes a fresh `startedAt` so the orphan reconciler's
   * age cutoff measures this attempt rather than the dead one.
   */
  async function redispatchExperiment(
    companyId: string,
    studyId: string,
    experimentId: string,
  ): Promise<ExperimentRow | null> {
    const timestamp = now();
    const updated = await db
      .update(experiments)
      .set({
        status: "running",
        heartbeatRunId: null,
        startedAt: timestamp,
        finishedAt: null,
      })
      .where(
        and(
          eq(experiments.companyId, companyId),
          eq(experiments.studyId, studyId),
          eq(experiments.id, experimentId),
          eq(experiments.status, "queued"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;
    await touchStudy(companyId, studyId, timestamp);
    return updated;
  }

  /**
   * Turn abandoned `running` rows into crashes.
   *
   * WHY this exists and why the pulse calls it first: after a host restart, a `running` row
   * whose process is gone stays `running` forever. Every "is an experiment running?" check
   * then answers yes forever, `beginExperiment` cannot take the GPU, and `skip_if_active`
   * refuses to advance. The study looks busy and has produced nothing for eight hours. A
   * crash is loud and recoverable; a stuck `running` row is neither.
   */
  async function reconcileOrphans(
    companyId: string,
    studyId: string,
    options: ReconcileOrphansOptions,
  ): Promise<ReconcileOrphansResult> {
    const study = await loadStudy(companyId, studyId);
    const actor = options.actor ?? ORPHAN_ACTOR;
    const graceSec = options.graceSec ?? 0;
    const cutoffSeconds = options.killAfterSec + graceSec + ORPHAN_RECONCILE_SLACK_SECONDS;
    const cutoff = new Date(now().getTime() - cutoffSeconds * 1000);

    const orphans = await db
      .select()
      .from(experiments)
      .where(
        and(
          eq(experiments.companyId, companyId),
          eq(experiments.studyId, studyId),
          eq(experiments.status, "running"),
          lt(experiments.startedAt, cutoff),
        ),
      );

    const reconciled: string[] = [];
    for (const orphan of orphans) {
      const ageSeconds = Math.max(
        0,
        Math.round((now().getTime() - (orphan.startedAt ?? orphan.createdAt).getTime()) / 1000),
      );
      // Reset to the last kept commit, or the baseline sha when nothing has been kept yet.
      // The working tree cannot be left holding a candidate that never earned a verdict.
      const targetSha = study.lastKeptSha ?? study.baselineGitSha ?? null;
      const cause =
        `orphaned run: still marked running ${ageSeconds}s after start, past the ` +
        `${cutoffSeconds}s budget (${options.killAfterSec}s kill + ${graceSec}s grace + ` +
        `${ORPHAN_RECONCILE_SLACK_SECONDS}s slack); no live trainer and no terminal ` +
        "heartbeat run can produce metrics for it";

      const settled = await db.transaction(async (tx) => {
        const updated = await tx
          .update(experiments)
          .set({
            status: "crashed",
            verdict: "crash",
            verdictReason: "val_bpb_regressed",
            // NULL, never the 0.000000 sentinel. The sentinel sorts as the BEST possible
            // val_bpb, so storing it here would let a crash be crowned champion by any min().
            valBpb: null,
            deltaVsBestAtTime: null,
            errorExcerpt: excerpt(cause),
            finishedAt: now(),
            adjudicatedAt: now(),
          })
          .where(
            and(
              eq(experiments.companyId, companyId),
              eq(experiments.id, orphan.id),
              eq(experiments.status, "running"),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        const verdictRow = await tx
          .insert(experimentVerdicts)
          .values({
            companyId,
            experimentId: orphan.id,
            studyId,
            verdict: "crash",
            verdictReason: "val_bpb_regressed",
            previousBestValBpb: study.bestValBpb,
            newBestValBpb: study.bestValBpb,
            gitAction: "reset_to_sha",
            targetSha,
            reason: cause,
            actorType: actor.actorType,
            actorId: actor.actorId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!verdictRow) throw new Error("orphan crash verdict row was not written");

        await tx
          .update(studies)
          .set({
            crashCount: sql`${studies.crashCount} + 1`,
            consecutiveCrashes: sql`${studies.consecutiveCrashes} + 1`,
            consecutiveDiscards: 0,
            lastActivityAt: now(),
            updatedAt: now(),
          })
          .where(and(eq(studies.companyId, companyId), eq(studies.id, studyId)));

        return updated;
      });
      if (!settled) continue;
      reconciled.push(orphan.id);

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "study.experiment_orphaned",
        entityType: "experiment",
        entityId: orphan.id,
        issueId: orphan.issueId,
        details: {
          studyId,
          sequence: orphan.sequence,
          ageSeconds,
          cutoffSeconds,
          killAfterSec: options.killAfterSec,
          graceSec,
          gitAction: "reset_to_sha",
          targetSha,
        },
      });
    }

    if (reconciled.length > 0) await regenerateResultsTsv(companyId, studyId);
    return { reconciled: reconciled.length, experimentIds: reconciled };
  }

  /**
   * Apply the executor's terminal outcome to an experiment.
   *
   * This is the settle step, not the verdict step: metrics land here and keep/discard is
   * decided separately by `adjudicate`, so a settle can be re-run safely and an operator can
   * still override the decision afterwards.
   */
  async function settleFromRun(input: SettleFromRunInput): Promise<SettleFromRunResult> {
    const actor = input.actor ?? FRAMEWORK_ACTOR;
    const study = await loadStudy(input.companyId, input.studyId);
    const experiment = await resolveSettableExperiment(input);
    if (!experiment) return { settled: false, experiment: null, metricsRejection: null };
    // Settling twice is a no-op, not a re-score. The first terminal outcome is the one that
    // actually happened and a late duplicate must not rewrite the record.
    if (SETTLED_STATUSES.has(experiment.status)) {
      return { settled: false, experiment, metricsRejection: null };
    }

    const timestamp = now();
    const status = OUTCOME_TO_STATUS[input.outcome];

    if (input.outcome !== "succeeded") {
      const cause = excerpt(input.error) ?? `run ${input.outcome} before producing a val_bpb`;

      // A death with no Python traceback came from outside the trainer: a GPU
      // driver reset, a lost CUDA context, a power event. Recorded on the target
      // machine as nvlddmkm event 153 killing a run mid-step, once producing an
      // empty log entirely. That says nothing about the idea under test, so
      // re-dispatch the same experiment rather than recording a failed
      // hypothesis - and do not let it advance the crash circuit breaker, which
      // exists to catch a genuinely broken setup.
      const failureClass = executorFailureClass(study, experiment);
      const attempts = experiment.transientAttempts + 1;
      const retryable =
        failureClass === "infrastructure" && attempts <= study.maxTransientRetries;

      if (retryable) {
        const requeued = await db
          .update(experiments)
          .set({
            // Back to queued rather than a terminal status, so the experiment is
            // still the one holding the sequence number and the idea is not
            // consumed. `adjudicatedAt` stays null because nothing was decided.
            status: "queued",
            heartbeatRunId: null,
            errorExcerpt: excerpt(`transient infrastructure failure: ${cause}`),
            transientAttempts: attempts,
            startedAt: null,
            finishedAt: null,
          })
          .where(
            and(
              eq(experiments.companyId, input.companyId),
              eq(experiments.id, experiment.id),
              eq(experiments.status, experiment.status),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!requeued) return { settled: false, experiment, metricsRejection: null };

        // Counted separately from the crash streak. This is a machine-health
        // signal an operator wants to see, but it must not trip the crash
        // circuit breaker, which exists to catch a genuinely broken setup.
        await db
          .update(studies)
          .set({
            transientFailures: sql`${studies.transientFailures} + 1`,
            lastActivityAt: timestamp,
            updatedAt: timestamp,
          })
          .where(and(eq(studies.companyId, input.companyId), eq(studies.id, input.studyId)));
        await touchStudy(input.companyId, input.studyId, timestamp);
        await logActivity(db, {
          companyId: input.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? input.runId,
          action: "study.experiment_requeued_after_transient_failure",
          entityType: "experiment",
          entityId: requeued.id,
          issueId: requeued.issueId,
          details: {
            studyId: input.studyId,
            sequence: requeued.sequence,
            outcome: input.outcome,
            failureClass,
            attempt: attempts,
            maxTransientRetries: study.maxTransientRetries,
          },
        });
        return {
          settled: true,
          experiment: requeued,
          metricsRejection: null,
          requeued: true,
        };
      }

      const updated = await settleAsTerminal(
        input,
        experiment,
        { status, valBpb: null, deltaVsBestAtTime: null, errorExcerpt: cause, finishedAt: timestamp },
        actor,
      );
      if (!updated) return { settled: false, experiment, metricsRejection: null };
      await touchStudy(input.companyId, input.studyId, timestamp);
      await logActivity(db, {
        companyId: input.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? input.runId,
        action: "study.experiment_settled",
        entityType: "experiment",
        entityId: updated.id,
        issueId: updated.issueId,
        details: {
          studyId: input.studyId,
          sequence: updated.sequence,
          outcome: input.outcome,
          status: updated.status,
          valBpb: null,
          errorExcerpt: updated.errorExcerpt,
        },
      });
      await regenerateResultsTsv(input.companyId, input.studyId);
      return { settled: true, experiment: updated, metricsRejection: null };
    }

    const metricsFile = studyMetricsFile({ repoPath: study.repoPath, tag: study.tag }, experiment.sequence);
    const payload = readMetricsJson(metricsFile);
    const rejection = payload === null ? null : metricsRejection(payload);
    if (payload === null || rejection !== null) {
      const cause = excerpt(rejection ?? `executor wrote no usable metrics payload at ${metricsFile}`);
      const updated = await settleAsTerminal(
        input,
        experiment,
        { status: "crashed", valBpb: null, deltaVsBestAtTime: null, errorExcerpt: cause, finishedAt: timestamp },
        actor,
      );
      if (!updated) return { settled: false, experiment, metricsRejection: rejection };
      await touchStudy(input.companyId, input.studyId, timestamp);
      await logActivity(db, {
        companyId: input.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? input.runId,
        action: "study.experiment_metrics_rejected",
        entityType: "experiment",
        entityId: updated.id,
        issueId: updated.issueId,
        details: { studyId: input.studyId, sequence: updated.sequence, rejection, metricsFile },
      });
      await regenerateResultsTsv(input.companyId, input.studyId);
      return { settled: true, experiment: updated, metricsRejection: rejection };
    }

    const metrics = jsonRecord(payload?.metrics);
    const valBpb = finiteNumber(metrics?.valBpb);
    if (valBpb === null) {
      return { settled: false, experiment, metricsRejection: "metrics payload has no finite val_bpb" };
    }

    const attestation = jsonRecord(payload?.attestation);
    const wallClockSeconds = finiteNumber(attestation?.wallClockSeconds);
    const totalSeconds = finiteNumber(metrics?.totalSeconds);
    const trainingSeconds = finiteNumber(metrics?.trainingSeconds);
    const peakVramMb = finiteNumber(metrics?.peakVramMb);
    const updated = await settleAsTerminal(
      input,
      experiment,
      {
        status: "succeeded",
        valBpb,
        // Frozen here and never recomputed. If a later experiment improves the study, this
        // row has to keep showing what it looked like when it finished, or the history of
        // what seemed good at the time is rewritten retroactively.
        deltaVsBestAtTime: study.bestValBpb === null ? null : roundDelta(valBpb - study.bestValBpb),
        peakVramMb,
        // Kept only for results.tsv parity with the executor's own export.
        memoryGb: peakVramMb === null ? null : roundTenth(peakVramMb / 1024),
        trainingSeconds,
        totalSeconds,
        // Wall clock minus total_seconds: interpreter startup, runtime detection, tokenizer
        // load, autotune.
        preflightSeconds:
          wallClockSeconds === null || totalSeconds === null
            ? null
            : roundTenth(Math.max(0, wallClockSeconds - totalSeconds)),
        evalSeconds:
          totalSeconds === null || trainingSeconds === null
            ? null
            : roundTenth(Math.max(0, totalSeconds - trainingSeconds)),
        mfuPercent: finiteNumber(metrics?.mfuPercent),
        totalTokensM: finiteNumber(metrics?.totalTokensM),
        numSteps: optionalInteger(metrics?.numSteps),
        numParamsM: finiteNumber(metrics?.numParamsM),
        depth: optionalInteger(metrics?.depth),
        trainBatchSize: optionalInteger(metrics?.trainBatchSize),
        evalBatchSize: optionalInteger(metrics?.evalBatchSize),
        activationCheckpointing: optionalBoolean(metrics?.activationCheckpointing),
        dataset: optionalText(metrics?.dataset),
        autotuneCold: Boolean(attestation?.autotuneCold),
        autotuneSelectedBatchSize: optionalInteger(attestation?.autotuneSelectedBatchSize),
        metricsJson: metrics,
        provenance: jsonRecord(payload?.provenance),
        attestation,
        errorExcerpt: null,
        finishedAt: timestamp,
      },
      actor,
    );
    if (!updated) return { settled: false, experiment, metricsRejection: null };

    await touchStudy(input.companyId, input.studyId, timestamp);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? input.runId,
      action: "study.experiment_settled",
      entityType: "experiment",
      entityId: updated.id,
      issueId: updated.issueId,
      details: {
        studyId: input.studyId,
        sequence: updated.sequence,
        outcome: "succeeded",
        valBpb,
        deltaVsBestAtTime: updated.deltaVsBestAtTime,
        memoryGb: updated.memoryGb,
      },
    });
    await regenerateResultsTsv(input.companyId, input.studyId);
    return { settled: true, experiment: updated, metricsRejection: null };
  }

  /**
   * The adjudication. One decision, one transaction.
   *
   * `resolveVerdict` is pure and performs no I/O, so the decision is computed before the
   * transaction opens and the transaction only applies an outcome that is already decided.
   * That is what keeps the audit row, the experiment columns, and the study counters from
   * ever disagreeing with each other.
   */
  async function adjudicate(input: AdjudicateInput): Promise<AdjudicateResult> {
    const actor = input.actor ?? FRAMEWORK_ACTOR;
    const experiment = await loadExperiment(input.companyId, input.experimentId);
    const study = await loadStudy(input.companyId, experiment.studyId);

    if (experiment.verdict) {
      throw conflict("Experiment has already been adjudicated", {
        experimentId: experiment.id,
        verdict: experiment.verdict,
      });
    }
    if (!SETTLED_STATUSES.has(experiment.status)) {
      throw conflict("Experiment must settle before it can be adjudicated", {
        experimentId: experiment.id,
        status: experiment.status,
      });
    }

    const complexityDeltaLines =
      input.complexityDeltaLines === undefined
        ? experiment.complexityDeltaLines
        : input.complexityDeltaLines;
    const simplificationKeepsInWindow = await countSimplificationKeepsInWindow(
      input.companyId,
      experiment.studyId,
      experiment.sequence,
    );

    const decision = resolveVerdict({
      valBpb: experiment.valBpb,
      complexityDeltaLines,
      bestValBpb: study.bestValBpb,
      noiseFloorBpb: study.noiseFloorBpb,
      isBaseline: experiment.kind === "baseline",
      simplificationKeepsInWindow,
      maxSimplificationKeepsPerWindow: study.maxSimplificationKeepsPerWindow,
      valBpbCeiling: input.valBpbCeiling ?? null,
    });

    const timestamp = now();
    // Only the decision can nominate a new best, and a crash never can: `updatesBest` is
    // only ever true for a run that produced a finite val_bpb.
    const nextBestValBpb = decision.updatesBest ? experiment.valBpb : null;
    const branchAdvances =
      decision.gitAction === "advanced" || decision.gitAction === "adopt_simplification";

    const applied = await db.transaction(async (tx) => {
      const updated = await tx
        .update(experiments)
        .set({
          status: VERDICT_TO_STATUS[decision.verdict],
          verdict: decision.verdict,
          verdictReason: decision.verdictReason,
          // Only a real metric improvement earns credit. A simplification keep advances the
          // branch without moving best_val_bpb, so it must not count toward the goal either.
          metricCredit: decision.metricCredit,
          complexityDeltaLines,
          adjudicatedAt: timestamp,
        })
        .where(
          and(
            eq(experiments.companyId, input.companyId),
            eq(experiments.id, experiment.id),
            isNull(experiments.verdict),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) {
        throw conflict("Experiment was adjudicated concurrently", { experimentId: experiment.id });
      }

      const verdictRow = await tx
        .insert(experimentVerdicts)
        .values({
          companyId: input.companyId,
          experimentId: experiment.id,
          studyId: experiment.studyId,
          verdict: decision.verdict,
          verdictReason: decision.verdictReason,
          previousBestValBpb: study.bestValBpb,
          newBestValBpb: nextBestValBpb ?? study.bestValBpb,
          gitAction: decision.gitAction,
          targetSha: input.targetSha ?? experiment.gitSha,
          reason: input.reason ?? decision.explanation,
          actorType: actor.actorType,
          actorId: actor.actorId,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!verdictRow) throw new Error("experiment verdict row was not written");

      const studyConditions = [
        eq(studies.companyId, input.companyId),
        eq(studies.id, experiment.studyId),
      ];
      if (nextBestValBpb !== null) {
        // Re-assert on the row itself that the candidate is not a crash. The rendered
        // results.tsv sentinel is 0.000000, which sorts as the best possible val_bpb, so a
        // crash is exactly the row that must never be eligible for the crown.
        studyConditions.push(
          sql`exists (
            select 1 from ${experiments}
            where ${experiments.id} = ${experiment.id}
              and ${experiments.verdict} is distinct from 'crash'
          )`,
        );
      }

      await tx
        .update(studies)
        .set({
          ...(decision.verdict === "keep" ? { keepCount: sql`${studies.keepCount} + 1` } : {}),
          ...(decision.verdict === "discard" ? { discardCount: sql`${studies.discardCount} + 1` } : {}),
          ...(decision.verdict === "crash" ? { crashCount: sql`${studies.crashCount} + 1` } : {}),
          // A crash streak is a hardware/tooling signal, not an idea-quality signal. Any run
          // that completed and produced a verdict proves the GPU is healthy again, so only
          // another crash extends the backoff.
          consecutiveCrashes:
            decision.verdict === "crash" ? sql`${studies.consecutiveCrashes} + 1` : sql`0`,
          consecutiveDiscards:
            decision.verdict === "keep" ? sql`0` : sql`${studies.consecutiveDiscards} + 1`,
          ...(branchAdvances && updated.gitSha ? { lastKeptSha: updated.gitSha } : {}),
          ...(nextBestValBpb !== null
            ? { bestValBpb: nextBestValBpb, bestExperimentId: experiment.id }
            : {}),
          lastActivityAt: timestamp,
          updatedAt: timestamp,
        })
        .where(and(...studyConditions));

      if (decision.verdict === "keep" && updated.ideaId) {
        // "won" means this idea produced a keep, so it is only set on a keep. A discard or a
        // crash leaves the idea visible to its proposer with the attempt count incremented,
        // which is the feedback it needs to do better.
        await tx
          .update(experimentIdeas)
          .set({ status: "won", decidedAt: timestamp })
          .where(
            and(
              eq(experimentIdeas.companyId, input.companyId),
              eq(experimentIdeas.id, updated.ideaId),
            ),
          );
      }

      return { experiment: updated, verdictRow };
    });

    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "study.experiment_adjudicated",
      entityType: "experiment",
      entityId: applied.experiment.id,
      issueId: applied.experiment.issueId,
      details: {
        studyId: experiment.studyId,
        sequence: experiment.sequence,
        verdict: decision.verdict,
        verdictReason: decision.verdictReason,
        gitAction: decision.gitAction,
        metricCredit: decision.metricCredit,
        valBpb: experiment.valBpb,
        previousBestValBpb: study.bestValBpb,
        newBestValBpb: nextBestValBpb ?? study.bestValBpb,
        simplificationKeepsInWindow,
        explanation: decision.explanation,
      },
    });

    await regenerateResultsTsv(input.companyId, experiment.studyId);

    const refreshed = await db
      .select({ bestValBpb: studies.bestValBpb, bestExperimentId: studies.bestExperimentId })
      .from(studies)
      .where(and(eq(studies.companyId, input.companyId), eq(studies.id, experiment.studyId)))
      .then((rows) => rows[0] ?? null);

    return {
      decision,
      experiment: applied.experiment,
      verdictRow: applied.verdictRow,
      bestValBpb: refreshed?.bestValBpb ?? null,
      bestExperimentId: refreshed?.bestExperimentId ?? null,
    };
  }

  /**
   * Regenerate `results.tsv` from the database.
   *
   * The database is authoritative and the file is a derived export, so it is rewritten
   * rather than appended. That self-heals the gap where the metrics were written and the
   * process died before a row was appended, and the write-then-rename means no reader ever
   * observes a half-written ledger. The column contract is upstream's, exactly five fields;
   * adding one would break the reader that has to parse it.
   */
  async function regenerateResultsTsv(companyId: string, studyId: string): Promise<string | null> {
    const study = await loadStudy(companyId, studyId);
    const rows = await db
      .select({
        gitSha: experiments.gitSha,
        valBpb: experiments.valBpb,
        memoryGb: experiments.memoryGb,
        verdict: experiments.verdict,
        status: experiments.status,
        description: experiments.description,
      })
      .from(experiments)
      .where(
        and(
          eq(experiments.companyId, companyId),
          eq(experiments.studyId, studyId),
          isNotNull(experiments.gitSha),
        ),
      )
      .orderBy(asc(experiments.sequence));

    const tsvRows: TsvExperimentRow[] = [];
    for (const row of rows) {
      const verdict =
        (row.verdict as ExperimentVerdict | null) ??
        TERMINAL_TSV_VERDICT[row.status as ExperimentStatus] ??
        null;
      // A run that succeeded but has not been adjudicated is skipped rather than labelled.
      // Writing `keep` here would publish a verdict the framework has not made, and the row
      // reappears the moment `adjudicate` runs.
      if (!verdict) continue;
      tsvRows.push({
        gitSha: row.gitSha as string,
        valBpb: row.valBpb,
        memoryGb: row.memoryGb,
        verdict,
        description: row.description,
      });
    }

    const content = renderResultsTsv(tsvRows);
    const target = study.resultsTsvPath ?? studyPaths({ repoPath: study.repoPath, tag: study.tag }).resultsTsv;
    try {
      ensureDir(dirname(target));
      writeResultsTsv(target, content);
    } catch (error) {
      // The ledger is derived. A filesystem failure must not fail the settle or the verdict
      // that produced it, or the study would stall on a full disk.
      logger.warn({ err: error, studyId, target }, "failed to regenerate study results.tsv");
      return null;
    }
    if (!study.resultsTsvPath) {
      await db
        .update(studies)
        .set({ resultsTsvPath: target, updatedAt: now() })
        .where(and(eq(studies.companyId, companyId), eq(studies.id, studyId)));
    }
    return content;
  }

  async function settleAsTerminal(
    input: SettleFromRunInput,
    experiment: ExperimentRow,
    values: Partial<typeof experiments.$inferInsert>,
    actor: StudyActor,
  ): Promise<ExperimentRow | null> {
    return db
      .update(experiments)
      .set({ ...values, heartbeatRunId: experiment.heartbeatRunId ?? input.runId })
      // `status = 'running'` is the guard. A settle that races with reconciliation or with
      // itself must not overwrite the terminal state that arrived first.
      .where(
        and(
          eq(experiments.companyId, input.companyId),
          eq(experiments.id, experiment.id),
          eq(experiments.status, "running"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function touchStudy(companyId: string, studyId: string, timestamp: Date): Promise<void> {
    await db
      .update(studies)
      .set({ lastActivityAt: timestamp, updatedAt: timestamp })
      .where(and(eq(studies.companyId, companyId), eq(studies.id, studyId)));
  }

  async function resolveSettableExperiment(input: SettleFromRunInput): Promise<ExperimentRow | null> {
    if (input.runId) {
      const byRun = await db
        .select()
        .from(experiments)
        .where(
          and(
            eq(experiments.companyId, input.companyId),
            eq(experiments.studyId, input.studyId),
            eq(experiments.heartbeatRunId, input.runId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (byRun) return byRun;
    }
    // Fall back to the study's single running experiment so a settle still works when the
    // heartbeat run never got linked to the row. A study only ever has one.
    const running = await db
      .select()
      .from(experiments)
      .where(
        and(
          eq(experiments.companyId, input.companyId),
          eq(experiments.studyId, input.studyId),
          eq(experiments.status, "running"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!running) return null;
    if (input.runId && running.heartbeatRunId === null) {
      await db
        .update(experiments)
        .set({ heartbeatRunId: input.runId })
        .where(and(eq(experiments.companyId, input.companyId), eq(experiments.id, running.id)));
      return { ...running, heartbeatRunId: input.runId };
    }
    return running;
  }

  async function countSimplificationKeepsInWindow(
    companyId: string,
    studyId: string,
    beforeSequence: number,
  ): Promise<number> {
    const window = await db
      .select({ verdictReason: experiments.verdictReason })
      .from(experiments)
      .where(
        and(
          eq(experiments.companyId, companyId),
          eq(experiments.studyId, studyId),
          sql`${experiments.sequence} < ${beforeSequence}`,
        ),
      )
      .orderBy(desc(experiments.sequence))
      .limit(SIMPLIFICATION_WINDOW_SIZE);
    return window.filter((row) => row.verdictReason === "simplification_win").length;
  }

  return {
    nextSequence,
    beginExperiment,
    redispatchExperiment,
    reconcileOrphans,
    settleFromRun,
    adjudicate,
    regenerateResultsTsv,

    listExperiments: (
      companyId: string,
      studyId: string,
      options: { status?: ExperimentStatus; limit?: number } = {},
    ) => {
      const conditions = [eq(experiments.companyId, companyId), eq(experiments.studyId, studyId)];
      if (options.status) conditions.push(eq(experiments.status, options.status));
      return db
        .select()
        .from(experiments)
        .where(and(...conditions))
        .orderBy(asc(experiments.sequence))
        .limit(options.limit ?? 500);
    },

    getExperiment: (companyId: string, experimentId: string) =>
      loadExperiment(companyId, experimentId),

    /** Sequence-ordered experiment list with best/winner badges and per-issue LLM cost. */
    leaderboard: async (companyId: string, studyId: string): Promise<StudyLeaderboardRow[]> => {
      const study = await loadStudy(companyId, studyId);
      const rows = await db
        .select()
        .from(experiments)
        .where(and(eq(experiments.companyId, companyId), eq(experiments.studyId, studyId)))
        .orderBy(asc(experiments.sequence));
      const costByIssueId = await llmCostByIssueId(db, companyId, rows);
      return rows.map((row) => ({
        experimentId: row.id,
        sequence: row.sequence,
        kind: row.kind as ExperimentKind,
        description: row.description,
        valBpb: row.valBpb,
        deltaVsBestAtTime: row.deltaVsBestAtTime,
        memoryGb: row.memoryGb,
        trainingSeconds: row.trainingSeconds,
        numParamsM: row.numParamsM,
        depth: row.depth,
        status: row.status as ExperimentStatus,
        verdict: row.verdict as ExperimentVerdict | null,
        verdictReason: row.verdictReason as ExperimentVerdictReason | null,
        complexityDeltaLines: row.complexityDeltaLines,
        metricCredit: row.metricCredit,
        gitSha: row.gitSha,
        isCurrentBest: row.id === study.bestExperimentId,
        isBranchHead: row.gitSha !== null && row.gitSha === study.lastKeptSha,
        llmCostCents: row.issueId ? (costByIssueId.get(row.issueId) ?? null) : null,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      }));
    },

    /** One point per settled experiment, in sequence order, for the progress chart. */
    progress: async (companyId: string, studyId: string): Promise<StudyProgressPoint[]> => {
      const study = await loadStudy(companyId, studyId);
      const gpuTotalVramBytes = readGpuTotalVramBytes(study);
      const rows = await db
        .select({
          id: experiments.id,
          sequence: experiments.sequence,
          valBpb: experiments.valBpb,
          memoryGb: experiments.memoryGb,
          verdict: experiments.verdict,
          finishedAt: experiments.finishedAt,
        })
        .from(experiments)
        .where(
          and(
            eq(experiments.companyId, companyId),
            eq(experiments.studyId, studyId),
            isNotNull(experiments.finishedAt),
          ),
        )
        .orderBy(asc(experiments.sequence));
      return rows.map((row) => ({
        sequence: row.sequence,
        valBpb: row.valBpb,
        memoryGb: row.memoryGb,
        verdict: row.verdict as ExperimentVerdict | null,
        isBest: row.id === study.bestExperimentId,
        gpuTotalVramBytes,
        finishedAt: row.finishedAt,
      }));
    },
  };
}

export type ExperimentsService = ReturnType<typeof experimentsService>;

/**
 * Per-issue LLM spend for the leaderboard.
 *
 * The experiment rows carry `issueId`, and cost events are recorded against the issue, so
 * joining on the issue is what makes "what did this experiment's proposal cost" answerable.
 * A GPU-minutes event is recorded with cost_cents 0, so summing cost_cents never mixes
 * wall time into money.
 */
async function llmCostByIssueId(
  db: Db,
  companyId: string,
  rows: ExperimentRow[],
): Promise<Map<string, number>> {
  const issueIds = [...new Set(rows.map((row) => row.issueId).filter((id): id is string => id !== null))];
  if (issueIds.length === 0) return new Map();
  const totals = await db
    .select({ issueId: costEvents.issueId, total: sum(costEvents.costCents) })
    .from(costEvents)
    .where(and(eq(costEvents.companyId, companyId), inArray(costEvents.issueId, issueIds)))
    .groupBy(costEvents.issueId);
  const mapped = new Map<string, number>();
  for (const row of totals) {
    if (row.issueId) mapped.set(row.issueId, Number(row.total ?? 0));
  }
  return mapped;
}
