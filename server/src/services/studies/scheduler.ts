import path from "node:path";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { agents, experiments, issues, studies, studyProposers } from "@paperclipai/db";
import {
  STUDY_EXPERIMENT_ORIGIN_KIND,
  STUDY_IDEA_PROPOSAL_ORIGIN_KIND,
} from "@paperclipai/shared";

import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { studyOrchestrator } from "./orchestrator.js";

/**
 * Statuses that still count as an open issue. A dispatch issue in any of these is
 * live work, so a second pulse must not open another.
 */
const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "blocked", "in_review"] as const;

/**
 * The scheduler tick that drives autoresearch studies.
 *
 * Deliberately deterministic and server-side. The pulse decides when a training
 * run starts, when a verdict applies, and when an orphan is reconciled; none of
 * that is a judgement call, and putting a language model in the path would mean
 * paying for a token to decide something a database constraint already decides.
 * The language models are the idea-proposer agents, and they are dispatched from
 * here as issues.
 *
 * Runs on the same scheduler beat as the other deterministic sweeps, which already
 * handle the things that would break a study: task drain, database restore, and
 * worktree-instance startup.
 */
export interface StudyTickResult {
  /** Active studies considered this beat. */
  evaluated: number;
  /** Studies whose pulse actually ran. */
  pulsed: number;
  /** Training runs dispatched to the executor this beat. */
  dispatched: number;
  /** Idea requests raised for proposer agents this beat. */
  requested: number;
  /** Studies that stopped advancing, with the reason. */
  stopped: { studyId: string; reason: string }[];
}

export interface StudySchedulerDeps {
  now?: () => Date;
  /** Creates the issue that dispatches a run, and wakes the executor on it. */
  dispatchExperiment?: (input: DispatchExperimentInput) => Promise<boolean>;
  /** Creates or re-wakes the issue that asks a proposer for an idea. */
  requestProposal?: (input: RequestProposalInput) => Promise<boolean>;
  /** Maximum studies to pulse in one beat, so one bad study cannot stall the rest. */
  maxStudiesPerTick?: number;
}

export interface DispatchExperimentInput {
  companyId: string;
  studyId: string;
  experimentId: string;
  sequence: number;
  description: string;
  agentId: string;
  worktreePath: string;
  killAfterSec: number;
}

export interface RequestProposalInput {
  companyId: string;
  studyId: string;
  proposerAgentId: string;
  openIdeas: number;
  minOpenIdeas: number;
}

const DEFAULT_MAX_STUDIES_PER_TICK = 20;

export function studyScheduler(db: Db, deps: StudySchedulerDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const maxStudies = deps.maxStudiesPerTick ?? DEFAULT_MAX_STUDIES_PER_TICK;

  /**
   * Whether an experiment already has an open dispatch issue.
   *
   * This is what makes dispatch idempotent. Two pulses - a retry, a second server
   * instance, a manual tick - must never put the same run on the GPU twice, and a
   * unique index cannot span the run lifecycle because the issue is created
   * before the experiment finishes. Keying on `originId` is the whole mechanism.
   */
  async function hasOpenDispatch(companyId: string, experimentId: string): Promise<boolean> {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STUDY_EXPERIMENT_ORIGIN_KIND),
          eq(issues.originId, experimentId),
          inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row !== null;
  }

  async function dispatchRunningExperiments(input: {
    companyId: string;
    studyId: string;
    executorAgentId: string;
    paths: ReturnType<typeof studyPathsFor>;
    killAfterSec: number;
  }): Promise<number> {
    const running = await db
      .select({
        id: experiments.id,
        sequence: experiments.sequence,
        description: experiments.description,
        heartbeatRunId: experiments.heartbeatRunId,
      })
      .from(experiments)
      .where(
        and(
          eq(experiments.companyId, input.companyId),
          eq(experiments.studyId, input.studyId),
          eq(experiments.status, "running"),
        ),
      )
      .orderBy(asc(experiments.sequence))
      .then((rows) => rows);

    let dispatched = 0;
    for (const experiment of running) {
      // A run that already owns a heartbeat run is genuinely in flight; the
      // scheduler only dispatches the ones the pulse just started or requeued.
      if (experiment.heartbeatRunId) continue;
      if (await hasOpenDispatch(input.companyId, experiment.id)) continue;

      const created = await deps.dispatchExperiment?.({
        companyId: input.companyId,
        studyId: input.studyId,
        experimentId: experiment.id,
        sequence: experiment.sequence,
        description: experiment.description,
        agentId: input.executorAgentId,
        worktreePath: input.paths.worktreePath,
        killAfterSec: input.killAfterSec,
      });
      if (created) dispatched += 1;
    }
    return dispatched;
  }

  /**
   * Asks the least recently asked proposer for an idea.
   *
   * Round-robin by `lastProposalAt` rather than "the first proposer": a single
   * fast agent would otherwise monopolise the arena and the study would explore
   * one mind's ideas, which defeats the point of having several.
   */
  async function requestProposals(input: {
    companyId: string;
    studyId: string;
    openIdeas: number;
    minOpenIdeas: number;
  }): Promise<number> {
    const wanted = input.minOpenIdeas - input.openIdeas;
    if (wanted <= 0) return 0;

    const proposers = await db
      .select({ agentId: studyProposers.agentId })
      .from(studyProposers)
      .where(
        and(
          eq(studyProposers.companyId, input.companyId),
          eq(studyProposers.studyId, input.studyId),
          eq(studyProposers.active, true),
        ),
      )
      // `asc nulls first`, in that order: never-asked proposers sort first so the
      // roster starts fairly. Wrapping this in `asc()` would emit the invalid
      // `nulls first asc`, because `asc()` appends its keyword after the fragment.
      .orderBy(sql`${studyProposers.lastProposalAt} asc nulls first`)
      .limit(wanted)
      .then((rows) => rows);

    let requested = 0;
    for (const proposer of proposers) {
      const ok = await deps.requestProposal?.({
        companyId: input.companyId,
        studyId: input.studyId,
        proposerAgentId: proposer.agentId,
        openIdeas: input.openIdeas,
        minOpenIdeas: input.minOpenIdeas,
      });
      if (!ok) continue;
      requested += 1;
      await db
        .update(studyProposers)
        .set({ lastProposalAt: now(), updatedAt: now() })
        .where(
          and(
            eq(studyProposers.companyId, input.companyId),
            eq(studyProposers.studyId, input.studyId),
            eq(studyProposers.agentId, proposer.agentId),
          ),
        );
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "study_scheduler",
        action: "study.idea_proposal_requested",
        entityType: "study",
        entityId: input.studyId,
        details: { proposerAgentId: proposer.agentId, openIdeas: input.openIdeas },
      });
    }
    return requested;
  }

  async function tickStudies(tickNow = new Date()): Promise<StudyTickResult> {
    const result: StudyTickResult = {
      evaluated: 0,
      pulsed: 0,
      dispatched: 0,
      requested: 0,
      stopped: [],
    };

    // Only studies whose pulse interval has elapsed. A study that is not due is
    // not touched at all, so an idle instance does almost no work per beat.
    const active = await db
      .select()
      .from(studies)
      .innerJoin(agents, eq(agents.id, studies.executorAgentId))
      .where(eq(studies.status, "active"))
      .limit(maxStudies * 4)
      .then((rows) =>
        rows
          .filter(({ studies: study }) => {
            const last = study.lastPulseAt?.getTime() ?? 0;
            return tickNow.getTime() - last >= study.pulseIntervalSec * 1000;
          })
          .slice(0, maxStudies),
      );

    result.evaluated = active.length;
    if (active.length === 0) return result;

    for (const { studies: study } of active) {
      // Claim the beat with a conditional update, exactly like the agent timer
      // heartbeat. Two server instances, or a retry after a slow beat, must not
      // both pulse the same study.
      const claimed = await db
        .update(studies)
        .set({ lastPulseAt: tickNow, updatedAt: tickNow })
        .where(
          and(
            eq(studies.id, study.id),
            eq(studies.status, "active"),
            or(
              isNull(studies.lastPulseAt),
              // An ISO string, not a Date: postgres.js binds a raw Date as a
              // byte parameter and rejects it for a timestamptz comparison.
              sql`${studies.lastPulseAt} <= ${new Date(
                tickNow.getTime() - study.pulseIntervalSec * 1000,
              ).toISOString()}`,
            ),
          ),
        )
        .returning({ id: studies.id })
        .then((rows) => rows[0] ?? null);
      if (!claimed) continue;

      result.pulsed += 1;

      try {
        let proposalsRequested = 0;
    const orchestrator = studyOrchestrator(db, {
          now: () => tickNow,
          requestIdeaProposals: async (proposal) => {
            const requested = await requestProposals(proposal);
            // Accumulated here rather than left to the pulse result: the pulse runs
            // the replenishment step itself, so its own boolean is not enough to
            // report how many proposers were actually asked.
            proposalsRequested += requested;
            return requested;
          },
        });
        const pulse = await orchestrator.runPulse({
          companyId: study.companyId,
          studyId: study.id,
        });
        if (!pulse.continuing) {
          result.stopped.push({ studyId: study.id, reason: pulse.reason });
          logger.warn(
            { studyId: study.id, reason: pulse.reason },
            "study stopped advancing",
          );
          continue;
        }
        result.requested += proposalsRequested;

        const paths = studyPathsFor(study);
        if (study.executorAgentId) {
          result.dispatched += await dispatchRunningExperiments({
            companyId: study.companyId,
            studyId: study.id,
            executorAgentId: study.executorAgentId,
            paths,
            killAfterSec: study.killAfterSec,
          });
        }
      } catch (error) {
        // One misbehaving study must not stop the others, and must not leave the
        // study claiming to be mid-pulse: `lastPulseAt` is already written, so the
        // next beat simply tries again.
        logger.error(
          { err: error, studyId: study.id },
          "study pulse failed",
        );
        result.stopped.push({ studyId: study.id, reason: "pulse threw" });
      }
    }

    if (result.pulsed > 0) {
      logger.debug(
        {
          evaluated: result.evaluated,
          pulsed: result.pulsed,
          dispatched: result.dispatched,
          requested: result.requested,
          stopped: result.stopped.length,
        },
        "study scheduler tick complete",
      );
    }
    return result;
  }

  return { tickStudies, hasOpenDispatch, dispatchRunningExperiments, requestProposals };
}

/**
 * The study's worktree, where the executor runs training.
 *
 * Must match what `workspace-runtime` provisions for `git_worktree` +
 * `existingBranch`, which is `path.join(repoRoot, ".paperclip", "worktrees",
 * branchName)` with the branch used *verbatim*: exact-branch realization assigns
 * `branchName = requestedExistingBranch` without sanitizing it, because renaming
 * would defeat the point of pinning an exact branch. A branch like
 * `autoresearch/mar5` therefore nests a directory rather than flattening to a
 * dash. `path.join` keeps Windows separators correct.
 *
 * A wrong guess here is not cosmetic: the executor would train a tree the
 * framework does not control and write metrics the ledger cannot reconcile.
 */
function studyPathsFor(study: { repoPath: string; branchName: string }) {
  return {
    worktreePath: path.join(
      study.repoPath,
      ".paperclip",
      "worktrees",
      study.branchName,
    ),
  };
}