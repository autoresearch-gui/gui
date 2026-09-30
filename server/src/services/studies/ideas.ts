import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { experimentIdeas, studies } from "@paperclipai/db";
import type {
  CreateExperimentIdea,
  ExperimentIdeaScores,
  IdeaExpectedDirection,
  IdeaStatus,
} from "@paperclipai/shared";
import { conflict, notFound } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { experimentsService, type ExperimentRow, type ExperimentsService, type StudyActor } from "./experiments.js";

/**
 * The idea pool and the GPU-arena selector.
 *
 * An idea is a proposal plus a patch. Nothing in this file evaluates the patch: the
 * framework commits it, runs it, and adjudicates the result. The only judgement expressed
 * here is which idea gets the GPU next.
 */

export type IdeaRow = typeof experimentIdeas.$inferSelect;

export interface SubmitIdeaInput extends CreateExperimentIdea {
  companyId: string;
  studyId: string;
  actor?: StudyActor;
}

export interface DecideIdeaInput {
  companyId: string;
  ideaId: string;
  reason?: string | null;
  actor?: StudyActor;
}

export interface SelectGpuWinnerResult {
  acquired: boolean;
  experiment: ExperimentRow | null;
  idea: IdeaRow | null;
  /**
   * True when the winner was drawn from the exploration quota, i.e. without looking at
   * predicted gain. Surfaced so an operator can see the quota actually firing.
   */
  exploreSlot: boolean;
  /** Why no idea could take the GPU. */
  reason: string | null;
}

const SYSTEM_ACTOR: StudyActor = { actorType: "system", actorId: "study_idea_selector" };

const EMPTY_SCORES: ExperimentIdeaScores = { novelty: 0, expectedGain: 0, simplicity: 0, risk: 0 };

function scoreTotalOf(scores: Partial<ExperimentIdeaScores> | null | undefined): number {
  if (!scores) return 0;
  let total = 0;
  for (const value of Object.values(scores)) {
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

export function ideasService(db: Db, deps: { experiments?: ExperimentsService; now?: () => Date } = {}) {
  const experiments = deps.experiments ?? experimentsService(db);
  const now = deps.now ?? (() => new Date());

  function loadIdea(companyId: string, ideaId: string) {
    return db
      .select()
      .from(experimentIdeas)
      .where(and(eq(experimentIdeas.companyId, companyId), eq(experimentIdeas.id, ideaId)))
      .then((rows) => rows[0] ?? null)
      .then((row) => {
        if (!row) throw notFound("Experiment idea not found");
        return row;
      });
  }

  function loadStudy(companyId: string, studyId: string) {
    return db
      .select()
      .from(studies)
      .where(and(eq(studies.companyId, companyId), eq(studies.id, studyId)))
      .then((rows) => rows[0] ?? null)
      .then((row) => {
        if (!row) throw notFound("Study not found");
        return row;
      });
  }

  async function submit(input: SubmitIdeaInput) {
    const actor = input.actor ?? SYSTEM_ACTOR;
    await loadStudy(input.companyId, input.studyId);
    // `score_total` is the ordering key for every non-exploration slot, so it is derived
    // from the submitted score components rather than accepted from the caller. A proposer
    // that could write its own ordering key would own the selection.
    const scores = input.scores ?? EMPTY_SCORES;
    const created = await db
      .insert(experimentIdeas)
      .values({
        companyId: input.companyId,
        studyId: input.studyId,
        issueId: input.issueId ?? null,
        proposingAgentId: actor.agentId ?? actor.actorId,
        title: input.title,
        rationale: input.rationale,
        expectedDirection: input.expectedDirection,
        family: input.family ?? null,
        patchFormat: input.patchFormat ?? "unified_diff",
        patchBody: input.patchBody,
        basedOnSha: input.basedOnSha ?? null,
        predictedValBpbDelta: input.predictedValBpbDelta ?? null,
        scores: { ...scores } as unknown as Record<string, unknown>,
        scoreTotal: scoreTotalOf(scores),
        criticScore: input.criticScore ?? null,
        status: "proposed",
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!created) throw conflict("Experiment idea was not created");

    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "study.idea_submitted",
      entityType: "experiment_idea",
      entityId: created.id,
      issueId: created.issueId,
      details: {
        studyId: input.studyId,
        title: created.title,
        expectedDirection: created.expectedDirection,
        family: created.family,
        scoreTotal: created.scoreTotal,
        patchFormat: created.patchFormat,
        predictedValBpbDelta: created.predictedValBpbDelta,
      },
    });
    return created;
  }

  function shortlist(input: DecideIdeaInput) {
    return decide(input, "shortlisted", "study.idea_shortlisted");
  }

  function reject(input: DecideIdeaInput & { reason: string }) {
    // A rejected idea has to say why, otherwise the proposer never learns what the
    // framework disliked about it and submits a variation of the same mistake.
    return decide(input, "rejected", "study.idea_rejected");
  }

  function withdraw(input: DecideIdeaInput) {
    return decide(input, "abandoned", "study.idea_withdrawn");
  }

  async function decide(input: DecideIdeaInput, status: IdeaStatus, action: string) {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const existing = await loadIdea(input.companyId, input.ideaId);
    const updated = await db
      .update(experimentIdeas)
      .set({
        status,
        rejectionReason: status === "rejected" || status === "abandoned" ? (input.reason ?? null) : null,
        decidedByType: actor.actorType,
        decidedById: actor.actorId,
        decidedAt: now(),
      })
      .where(
        and(
          eq(experimentIdeas.companyId, input.companyId),
          eq(experimentIdeas.id, input.ideaId),
          // Only an open idea can be decided, so a decided idea cannot be flipped back into
          // the pool and spent twice.
          sql`${experimentIdeas.status} not in ('won', 'abandoned')`,
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) {
      throw conflict("Experiment idea has already been decided", {
        ideaId: input.ideaId,
        status: existing.status,
      });
    }

    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action,
      entityType: "experiment_idea",
      entityId: updated.id,
      issueId: updated.issueId,
      details: {
        studyId: updated.studyId,
        title: updated.title,
        fromStatus: existing.status,
        toStatus: status,
        reason: input.reason ?? null,
      },
    });
    return updated;
  }

  /**
   * Draw the next idea and hand it the GPU.
   *
   * Every `exploreEveryN`-th proposal slot is an exploration slot, and an exploration slot
   * draws from `expectedDirection === "explore"` ideas WITHOUT consulting
   * `predictedValBpbDelta`. WHY that matters: a scoring formula that filters on predicted
   * gain turns explore-and-judge-by-result into exploit-the-proposer's-own-prior. The same
   * LLM writes the patch and rates the patch, so a gate on the predicted delta is a gate on
   * the model's opinion of an idea it just had. A radical architectural change is exactly
   * the idea whose predicted delta a transformer specialist rates low, because the reason
   * it wins is not visible from inside the current design. Those ideas are the only ones
   * that move `val_bpb` far, and the quota is the only thing that keeps them in the arena.
   *
   * On `{ acquired: false }` the GPU is held by another experiment, so the selector falls
   * through to the next candidate rather than queueing: there is one card and nothing
   * useful to do while it is busy.
   */
  async function selectGpuWinner(companyId: string, studyId: string): Promise<SelectGpuWinnerResult> {
    const study = await loadStudy(companyId, studyId);
    const sequence = await experiments.nextSequence(studyId);
    const exploreEveryN = Math.max(1, study.exploreEveryN);
    // Sequence 1 is the baseline characterization run, not a proposal, so the exploration
    // quota counts proposals from the first hypothesis rather than from the baseline.
    const proposalSequence = Math.max(1, sequence - 1);
    const exploreSlot = proposalSequence % exploreEveryN === 0;

    const shortlisted = await db
      .select()
      .from(experimentIdeas)
      .where(
        and(
          eq(experimentIdeas.companyId, companyId),
          eq(experimentIdeas.studyId, studyId),
          eq(experimentIdeas.status, "shortlisted"),
        ),
      )
      .orderBy(desc(experimentIdeas.scoreTotal), asc(experimentIdeas.createdAt));

    if (shortlisted.length === 0) {
      return {
        acquired: false,
        experiment: null,
        idea: null,
        exploreSlot,
        reason: "no shortlisted ideas are available",
      };
    }

    const exploreCandidates = shortlisted.filter((idea) => idea.expectedDirection === "explore");
    // An exploration slot with no explore ideas still has to make progress, so it falls back
    // to the score ordering rather than idling the card.
    const candidates = exploreSlot && exploreCandidates.length > 0 ? exploreCandidates : shortlisted;

    for (const idea of candidates) {
      const begun = await experiments.beginExperiment({
        companyId,
        studyId,
        kind: "hypothesis",
        description: idea.title,
        hypothesis: idea.rationale,
        ideaId: idea.id,
        issueId: idea.issueId,
      });
      if (!begun.acquired) continue;
      return { acquired: true, experiment: begun.experiment, idea, exploreSlot, reason: null };
    }

    return {
      acquired: false,
      experiment: null,
      idea: null,
      exploreSlot,
      reason: "every candidate lost the GPU arbitration",
    };
  }

  return {
    submit,
    shortlist,
    reject,
    withdraw,
    selectGpuWinner,

    list: (companyId: string, studyId: string, status?: IdeaStatus) => {
      const conditions = [eq(experimentIdeas.companyId, companyId), eq(experimentIdeas.studyId, studyId)];
      if (status) conditions.push(eq(experimentIdeas.status, status));
      return db
        .select()
        .from(experimentIdeas)
        .where(and(...conditions))
        .orderBy(desc(experimentIdeas.scoreTotal), asc(experimentIdeas.createdAt));
    },

    get: (companyId: string, ideaId: string) => loadIdea(companyId, ideaId),

    /** The pool the selector consumes, in the order it consumes it. */
    shortlistPool: (companyId: string, studyId: string) =>
      db
        .select()
        .from(experimentIdeas)
        .where(
          and(
            eq(experimentIdeas.companyId, companyId),
            eq(experimentIdeas.studyId, studyId),
            eq(experimentIdeas.status, "shortlisted"),
          ),
        )
        .orderBy(desc(experimentIdeas.scoreTotal), asc(experimentIdeas.createdAt)),

    /**
     * What the next slot will draw from, without drawing. Lets the pulse decide whether to
     * prompt a proposer for an `explore` idea before it blocks on an empty pool.
     */
    nextSlotDirection: async (
      companyId: string,
      studyId: string,
    ): Promise<{ sequence: number; exploreSlot: boolean; direction: IdeaExpectedDirection }> => {
      const study = await loadStudy(companyId, studyId);
      const sequence = await experiments.nextSequence(studyId);
      const exploreEveryN = Math.max(1, study.exploreEveryN);
      const exploreSlot = Math.max(1, sequence - 1) % exploreEveryN === 0;
      return { sequence, exploreSlot, direction: exploreSlot ? "explore" : "improve" };
    },
  };
}

export type IdeasService = ReturnType<typeof ideasService>;
