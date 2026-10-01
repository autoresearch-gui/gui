import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { experimentIdeas, experiments, studies } from "@paperclipai/db";

import { logger } from "../../middleware/logger.js";
import { notFound } from "../../errors.js";
import { experimentsService } from "./experiments.js";
import { ideasService } from "./ideas.js";
import {
  acquireGpuLock,
  inspectGpuLock,
  isProcessAlive,
  releaseGpuLock,
} from "./gpu-lock.js";
import { studyPaths } from "./paths.js";

/**
 * The pulse: one bounded pass that advances the study by at most one step.
 *
 * This is the mechanism that makes "LOOP FOREVER" survivable. A study left
 * running overnight dies in one of four ways, and each has a check here:
 *
 *  1. The host reboots and an experiment row stays `running` forever. Then the
 *     pulse's own "is something running?" check no-ops forever, the routine's
 *     `skip_if_active` refuses to advance, and the study looks busy while
 *     producing nothing. Reconciling orphans FIRST is what prevents that.
 *  2. The executor dies mid-run and leaves the experiment unsettled.
 *  3. The GPU is still held by a leaked trainer, so a new run would contend with
 *     it and every metric after it would be quietly invalid.
 *  4. The arena runs dry and nothing is queued.
 *
 * Each check no-ops or advances exactly one step, so a pulse is cheap to run
 * often and safe to run late. Reconciliation is deliberately step 0 and
 * unconditional: it must run before any check that could be blocked by a stale
 * row.
 */
export interface PulseStep {
  name: "reconcile_orphans" | "reclaim_gpu_lock" | "select_idea" | "replenish_arena";
  acted: boolean;
  detail: string;
}

export interface PulseResult {
  studyId: string;
  ran: boolean;
  steps: PulseStep[];
  /** True when the study is healthy and may keep going. */
  continuing: boolean;
  reason: string;
}

export interface OrchestratorDeps {
  /** Number of ideas that should be open before the arena asks for more. */
  minOpenIdeas?: number;
  /**
   * Asks proposers for more ideas. Injected so tests need no agents.
   *
   * Carries the counts the pulse already computed, so the caller can decide how
   * many to ask without repeating the query.
   */
  requestIdeaProposals?: (input: {
    companyId: string;
    studyId: string;
    count: number;
    openIdeas: number;
    minOpenIdeas: number;
  }) => Promise<number>;
  now?: () => Date;
}

const DEFAULT_MIN_OPEN_IDEA_COUNT = 4;
/** Above this, a study is considered wedged rather than busy. */
const CONSECUTIVE_CRASH_LIMIT = 5;

export function studyOrchestrator(db: Db, deps: OrchestratorDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const experimentsSvc = experimentsService(db);
  const ideasSvc = ideasService(db);
  const minOpenIdeas = deps.minOpenIdeas ?? DEFAULT_MIN_OPEN_IDEA_COUNT;

  async function runPulse(input: { companyId: string; studyId: string }): Promise<PulseResult> {
    const study = await db
      .select()
      .from(studies)
      .where(
        and(eq(studies.companyId, input.companyId), eq(studies.id, input.studyId)),
      )
      .then((rows) => rows[0] ?? null);
    if (!study) throw notFound("Study not found");

    const steps: PulseStep[] = [];
    const paths = studyPaths(study);

    if (study.status !== "active") {
      // A paused study is paused on purpose. Doing nothing is the correct
      // behaviour, and saying so explicitly keeps a paused study from looking
      // like a wedged one.
      return {
        studyId: study.id,
        ran: false,
        steps,
        continuing: false,
        reason: `study is ${study.status}, not active`,
      };
    }

    if (study.consecutiveCrashes >= CONSECUTIVE_CRASH_LIMIT) {
      // A crash streak is a hardware or tooling signal, not an idea-quality one.
      // Continuing would burn the GPU on the same failure all night, so this
      // stops and says why rather than limping.
      return {
        studyId: study.id,
        ran: false,
        steps,
        continuing: false,
        reason: `paused after ${study.consecutiveCrashes} consecutive crashes; this is a tooling or hardware problem, not an idea`,
      };
    }

    // ── Step 0: reconcile orphans ────────────────────────────────────────────
    // Unconditional and first. Everything below can be blocked by a stale
    // `running` row, so this has to happen before any of them.
    const reconciled = await experimentsSvc.reconcileOrphans(
      input.companyId,
      study.id,
      { killAfterSec: study.killAfterSec },
    );
    steps.push({
      name: "reconcile_orphans",
      acted: reconciled.reconciled > 0,
      detail:
        reconciled.reconciled > 0
          ? `reconciled ${reconciled.reconciled} orphaned run(s) into crashes`
          : "no orphaned runs",
    });

    // ── Step 1: reclaim a leaked GPU lock ───────────────────────────────────
    // Before starting anything. A leaked trainer means two processes share the
    // card and every metric after it is invalid while the study still looks
    // healthy, which is worse than a crash because it produces plausible numbers.
    const lock = inspectGpuLock(paths.gpuLockFile);
    if (lock.held && lock.owner && !isProcessAlive(lock.owner.pid)) {
      releaseGpuLock(paths.gpuLockFile);
      steps.push({
        name: "reclaim_gpu_lock",
        acted: true,
        detail: `reclaimed the GPU lock left by dead pid ${lock.owner.pid}`,
      });
    }

    // ── Step 2: start the next experiment ───────────────────────────────────
    // The heartbeat hook settles runs as they finish, so anything still marked
    // running here is genuinely in flight and the slot is not free.
    const running = await db
      .select({ id: experiments.id, sequence: experiments.sequence })
      .from(experiments)
      .where(
        and(
          eq(experiments.companyId, input.companyId),
          eq(experiments.studyId, study.id),
          eq(experiments.status, "running"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!running) {
      // A requeued experiment goes first. It already holds a sequence number, an
      // idea, and a commit, and its retry budget is finite. Promoting a NEW idea
      // instead would let it sit in `queued` forever while the study silently
      // stopped testing it.
      const requeued = await db
        .select({ id: experiments.id, sequence: experiments.sequence })
        .from(experiments)
        .where(
          and(
            eq(experiments.companyId, input.companyId),
            eq(experiments.studyId, study.id),
            eq(experiments.status, "queued"),
          ),
        )
        .orderBy(experiments.sequence)
        .then((rows) => rows[0] ?? null);

      const acquired = acquireGpuLock(paths.gpuLockFile, {
        ownerPid: process.pid,
        ttlSeconds: study.killAfterSec,
      });
      if (!acquired.acquired) {
        // Another pulse or a live run holds it. Not an error: the study simply is
        // not ready for the next experiment yet.
        steps.push({
          name: "select_idea",
          acted: false,
          detail: `GPU slot held by pid ${acquired.heldBy?.pid ?? "another process"}`,
        });
      } else if (requeued) {
        const redispatched = await experimentsSvc.redispatchExperiment(
          input.companyId,
          study.id,
          requeued.id,
        );
        steps.push({
          name: "select_idea",
          acted: redispatched !== null,
          detail: redispatched
            ? `re-dispatched experiment #${redispatched.sequence} after a transient failure`
            : `could not re-dispatch #${requeued.sequence}`,
        });
      } else {
        const winner = await ideasSvc.selectGpuWinner(input.companyId, study.id);
        if (winner.acquired && winner.experiment) {
          steps.push({
            name: "select_idea",
            acted: true,
            detail:
              `promoted idea ${winner.idea?.id ?? "none"} to experiment #${winner.experiment.sequence}` +
              (winner.exploreSlot ? " (exploration quota)" : ""),
          });
        } else {
          // Nothing to run. Release the lock so a later pulse is not blocked by
          // this one, then fall through to replenishing the arena.
          releaseGpuLock(paths.gpuLockFile);
          steps.push({
            name: "select_idea",
            acted: false,
            detail: winner.experiment
              ? "the GPU slot was already taken"
              : "no shortlisted idea was available to run",
          });
        }
      }
    }

    // ── Step 3: replenish the arena ─────────────────────────────────────────
    // Runs whether or not an experiment started. Ideas are cheap next to an
    // eleven-minute GPU run, and having the next proposal drafted while the
    // current one trains is what keeps the GPU from idling between experiments.
    const openIdeas = await db
      .select({ id: experimentIdeas.id })
      .from(experimentIdeas)
      .where(
        and(
          eq(experimentIdeas.companyId, input.companyId),
          eq(experimentIdeas.studyId, study.id),
          eq(experimentIdeas.status, "shortlisted"),
        ),
      )
      .then((rows) => rows.length);
    if (openIdeas < minOpenIdeas && deps.requestIdeaProposals) {
      const requested = await deps.requestIdeaProposals({
        companyId: input.companyId,
        studyId: study.id,
        count: minOpenIdeas - openIdeas,
        openIdeas,
        minOpenIdeas,
      });
      steps.push({
        name: "replenish_arena",
        acted: requested > 0,
        detail: `asked for ${requested} idea(s); ${openIdeas}/${minOpenIdeas} were shortlisted`,
      });
    }

    logger.debug(
      { studyId: study.id, steps: steps.map((step) => `${step.name}:${step.acted}`) },
      "study pulse complete",
    );

    return {
      studyId: study.id,
      ran: true,
      steps,
      continuing: true,
      reason: "study is active and advancing",
    };
  }

  return { runPulse, now };
}