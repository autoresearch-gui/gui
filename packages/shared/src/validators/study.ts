import { z } from "zod";
import {
  BASELINE_SOURCES,
  EXPERIMENT_VERDICT_REASONS,
  EXPERIMENT_VERDICTS,
  IDEA_EXPECTED_DIRECTIONS,
  IDEA_FAMILIES,
  STUDY_STATUSES,
} from "../constants.js";
import { objectWithoutDefaults } from "./partial.js";

export const createStudySchema = z.object({
  projectId: z.string().guid().optional().nullable(),
  name: z.string().trim().min(1).max(200),
  /** Also names the `autoresearch/<tag>` branch, so it stays url/shell safe. */
  tag: z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9._-]*$/),
  baseRef: z.string().trim().min(1).max(200),
  repoPath: z.string().trim().min(1).max(400),
  protocolDocumentId: z.string().guid().optional().nullable(),
  status: z.enum(STUDY_STATUSES).optional().default("setup"),
  venvPath: z.string().trim().max(400).optional().nullable(),
  cacheDir: z.string().trim().max(400).optional().nullable(),
  timeBudgetSec: z.number().int().min(60).max(86_400).optional().default(300),
  /**
   * Hard wall-clock kill for a training run, measured from spawn.
   *
   * 900s is the Gate 0 measurement on an RTX 4060 Ti: training ran 311.5s and
   * evaluation over the full `EVAL_TOKENS` added ~360s more, for 676.6s of wall
   * clock. The budget is training-only and excludes startup, runtime detection,
   * tokenizer load, and evaluation, so this has to clear all of it. The
   * upstream autoresearch "kill past 10 minutes" rule assumed a far faster GPU
   * and would discard a legitimate run here.
   */
  killAfterSec: z.number().int().min(60).max(86_400).optional().default(900),
  isBaselineRequired: z.boolean().optional().default(true),
  baselineValBpb: z.number().finite().optional().nullable(),
  baselineGitSha: z.string().trim().max(64).optional().nullable(),
  baselineSource: z.enum(BASELINE_SOURCES).optional().nullable(),
  baselineNote: z.string().trim().max(2000).optional().nullable(),
  noiseFloorBpb: z.number().finite().nonnegative().optional().nullable(),
  targetValBpb: z.number().finite().optional().nullable(),
  /** Retain the best checkpoint plus this many of the most recent keeps. */
  keepLastNKeeps: z.number().int().min(1).max(1000).optional().default(3),
  /**
   * Every Nth experiment is drawn from `expectedDirection: "explore"` ideas
   * without predicted-gain gating, so the arena cannot collapse into
   * exploiting the proposer's own prior.
   */
  exploreEveryN: z.number().int().min(1).max(1000).optional().default(4),
  minOpenIdeas: z.number().int().min(0).max(1000).optional().default(4),
  maxCrashRetriesPerIdea: z.number().int().min(0).max(20).optional().default(2),
  /**
   * Caps `adopt_simplification` verdicts inside a rolling 5-experiment window,
   * so an agent cannot simplify the model into the ground. The window size is
   * enforced by the service, not here.
   */
  maxSimplificationKeepsPerWindow: z.number().int().min(0).max(1000).optional().default(1),
});
export type CreateStudy = z.infer<typeof createStudySchema>;

export const updateStudySchema = objectWithoutDefaults(createStudySchema).partial();
export type UpdateStudy = z.infer<typeof updateStudySchema>;

// Baseline values land at start time, not create time: a study with a required
// baseline cannot become active without one, because every keep/discard verdict
// is relative to the baseline.
export const startStudySchema = z.object({
  baselineValBpb: z.number().finite().optional().nullable(),
  baselineGitSha: z.string().trim().max(64).optional().nullable(),
  baselineSource: z.enum(BASELINE_SOURCES).optional().nullable(),
  baselineNote: z.string().trim().max(2000).optional().nullable(),
  noiseFloorBpb: z.number().finite().nonnegative().optional().nullable(),
});
export type StartStudy = z.infer<typeof startStudySchema>;

export const concludeStudySchema = z.object({
  reason: z.string().trim().max(2000).optional().nullable(),
  notes: z.array(z.string().trim().max(2000)).max(50).optional().default([]),
});
export type ConcludeStudy = z.infer<typeof concludeStudySchema>;

export const recordVerdictSchema = z.object({
  verdict: z.enum(EXPERIMENT_VERDICTS),
  verdictReason: z.enum(EXPERIMENT_VERDICT_REASONS),
  complexityDeltaLines: z.number().int().optional().nullable(),
  reason: z.string().trim().max(2000).optional().nullable(),
  // Optimistic concurrency guard: reject when the study already moved past the
  // revision the adjudicator observed.
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type RecordVerdict = z.infer<typeof recordVerdictSchema>;

export const createExperimentIdeaSchema = z.object({
  issueId: z.string().guid().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  rationale: z.string().trim().min(1).max(4000),
  expectedDirection: z.enum(IDEA_EXPECTED_DIRECTIONS),
  family: z.enum(IDEA_FAMILIES).optional().nullable(),
  patchFormat: z.enum(["unified_diff", "full_file"]).optional().default("unified_diff"),
  patchBody: z.string().trim().min(1).max(200_000),
  basedOnSha: z.string().trim().max(64).optional().nullable(),
  predictedValBpbDelta: z.number().finite().optional().nullable(),
  scores: z.object({
    novelty: z.number().min(0).max(10),
    expectedGain: z.number().min(0).max(10),
    simplicity: z.number().min(0).max(10),
    risk: z.number().min(0).max(10),
  }).optional().nullable(),
  criticScore: z.number().min(0).max(10).optional().nullable(),
});
export type CreateExperimentIdea = z.infer<typeof createExperimentIdeaSchema>;

export const shortlistIdeaSchema = z.object({
  reason: z.string().trim().max(2000).optional().nullable(),
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type ShortlistIdea = z.infer<typeof shortlistIdeaSchema>;

export const rejectIdeaSchema = z.object({
  // A rejected idea must say why, otherwise the proposer cannot learn from it.
  reason: z.string().trim().min(1).max(2000),
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type RejectIdea = z.infer<typeof rejectIdeaSchema>;