import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

// A study is one autoresearch run pinned to one `autoresearch/<tag>` git branch.
// Everything the framework measures hangs off this row: the branch, the venv and cache
// directories, the wall-clock budget, and the best val_bpb seen so far.
export const studies = pgTable(
  "studies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Nullable because a study can exist before it is attached to a project.
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    // Pins the long-lived branch worktree; the framework advances the branch in place.
    executionWorkspaceId: uuid("execution_workspace_id")
      .references(() => executionWorkspaces.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    tag: text("tag").notNull(),
    branchName: text("branch_name").notNull(),
    baseRef: text("base_ref").notNull(),
    repoPath: text("repo_path").notNull(),
    // The human-editable protocol, seeded from the upstream program.md.
    protocolDocumentId: uuid("protocol_document_id").references(() => documents.id, { onDelete: "set null" }),
    protocolRevision: integer("protocol_revision"),
    status: text("status").notNull().default("setup"),
    gpuProfileJson: jsonb("gpu_profile_json").$type<Record<string, unknown>>(),
    // The venv lives OUTSIDE the worktree so resetting the branch cannot destroy it.
    venvPath: text("venv_path"),
    // Pinned AUTORESEARCH_CACHE_DIR; a warm tokenizer cache is the difference between
    // a 5 minute experiment and a 20 minute one.
    cacheDir: text("cache_dir"),
    timeBudgetSec: integer("time_budget_sec").notNull().default(300),
    // Hard wall-clock kill. It must exceed timeBudgetSec because the training budget
    // excludes interpreter startup, runtime detection, tokenizer load, autotune, and
    // the final eval pass.
    killAfterSec: integer("kill_after_sec").notNull().default(600),
    isBaselineRequired: boolean("is_baseline_required").notNull().default(true),
    baselineValBpb: doublePrecision("baseline_val_bpb"),
    baselineGitSha: text("baseline_git_sha"),
    baselineSource: text("baseline_source"),
    baselineNote: text("baseline_note"),
    // Measured from 3 baseline runs; used to reject sub-noise-floor "improvements".
    noiseFloorBpb: doublePrecision("noise_floor_bpb"),
    bestValBpb: doublePrecision("best_val_bpb"),
    // Declared with a deferred reference because experiments is defined further down in
    // this file and the two tables reference each other.
    bestExperimentId: uuid("best_experiment_id").references((): AnyPgColumn => experiments.id, {
      onDelete: "set null",
    }),
    targetValBpb: doublePrecision("target_val_bpb"),
    experimentCount: integer("experiment_count").notNull().default(0),
    keepCount: integer("keep_count").notNull().default(0),
    discardCount: integer("discard_count").notNull().default(0),
    crashCount: integer("crash_count").notNull().default(0),
    consecutiveCrashes: integer("consecutive_crashes").notNull().default(0),
    consecutiveDiscards: integer("consecutive_discards").notNull().default(0),
    lastKeptSha: text("last_kept_sha"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    resultsTsvPath: text("results_tsv_path"),
    keepLastNKeeps: integer("keep_last_n_keeps").notNull().default(3),
    // Every exploreEveryN-th experiment must be drawable without a predicted-gain gate.
    exploreEveryN: integer("explore_every_n").notNull().default(4),
    minOpenIdeas: integer("min_open_ideas").notNull().default(4),
    maxCrashRetriesPerIdea: integer("max_crash_retries_per_idea").notNull().default(2),
    maxSimplificationKeepsPerWindow: integer("max_simplification_keeps_per_window").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    concludedAt: timestamp("concluded_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // This unique index is what prevents two studies from racing for the same
    // `autoresearch/<tag>` branch. Application-level "check then insert" is not enough
    // because two setup requests can pass the check concurrently; the database has to
    // reject the second one.
    companyTagUq: uniqueIndex("studies_company_tag_uq").on(table.companyId, table.tag),
    companyStatusIdx: index("studies_company_status_idx").on(table.companyId, table.status),
    companyLastActivityIdx: index("studies_company_last_activity_idx").on(table.companyId, table.lastActivityAt),
  }),
);

// ideas are declared before experiments so experiments.idea_id can reference them.
// `scores` and `predicted_val_bpb_delta` are used for ORDERING only, never for gating.
// Every exploreEveryN-th experiment has to be drawable without predicted-gain gating,
// otherwise a scoring formula ends up rewarding the proposer's own prior and quietly
// suppresses radical architectural changes.
export const experimentIdeas = pgTable(
  "experiment_ideas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    studyId: uuid("study_id").notNull().references(() => studies.id, { onDelete: "cascade" }),
    // The proposer's own issue, which carries the conversation that produced the patch.
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    proposingAgentId: uuid("proposing_agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    expectedDirection: text("expected_direction").notNull().default("improve"),
    family: text("family"),
    patchFormat: text("patch_format").notNull().default("unified_diff"),
    patchBody: text("patch_body").notNull(),
    basedOnSha: text("based_on_sha"),
    predictedValBpbDelta: doublePrecision("predicted_val_bpb_delta"),
    scores: jsonb("scores").$type<Record<string, unknown>>().notNull(),
    scoreTotal: doublePrecision("score_total").notNull().default(0),
    criticScore: doublePrecision("critic_score"),
    status: text("status").notNull().default("proposed"),
    rejectionReason: text("rejection_reason"),
    decidedByType: text("decided_by_type"),
    // Agent or user id depending on decided_by_type; deliberately untyped at the
    // database level because the id space is not shared.
    decidedById: uuid("decided_by_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    studyStatusIdx: index("experiment_ideas_study_status_idx").on(table.studyId, table.status),
    studyScoreTotalIdx: index("experiment_ideas_study_score_total_idx").on(table.studyId, table.scoreTotal),
    proposingAgentIdx: index("experiment_ideas_proposing_agent_idx").on(table.proposingAgentId),
  }),
);

// One row per ~5 minute training run, scored on val_bpb (lower is better).
export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    studyId: uuid("study_id").notNull().references(() => studies.id, { onDelete: "cascade" }),
    // The Paperclip issue that represents this experiment. Deliberately NOT linked to
    // issues.harness_kind: that column is NOT NULL and functions as a global hide flag,
    // so setting it would also exclude these issues from per-issue cost rollups.
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    ideaId: uuid("idea_id").references(() => experimentIdeas.id, { onDelete: "set null" }),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    hypothesis: text("hypothesis"),
    // Full 40 char sha; the rendered results.tsv shows slice(0, 7).
    gitSha: text("git_sha"),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    verdict: text("verdict"),
    verdictReason: text("verdict_reason"),
    // True only when this experiment set a new best. The framework, not an LLM, applies
    // keep/discard and advances or resets the branch.
    metricCredit: boolean("metric_credit").notNull().default(false),
    complexityDeltaLines: integer("complexity_delta_lines"),
    // NULL means "no metric". Never store the 0.000000 crash sentinel here: it sorts as
    // the BEST possible val_bpb and would let a crash be crowned champion. The sentinel
    // exists only in the rendered results.tsv.
    valBpb: doublePrecision("val_bpb"),
    // Frozen at settle time and never recomputed, so a later improvement cannot
    // retroactively rewrite the history of what looked good at the time.
    deltaVsBestAtTime: doublePrecision("delta_vs_best_at_time"),
    peakVramMb: doublePrecision("peak_vram_mb"),
    // peak_vram_mb / 1024 to 1dp, kept only for results.tsv parity.
    memoryGb: doublePrecision("memory_gb"),
    trainingSeconds: doublePrecision("training_seconds"),
    totalSeconds: doublePrecision("total_seconds"),
    // Wall clock minus total_seconds: startup, runtime detection, tokenizer load, autotune.
    preflightSeconds: doublePrecision("preflight_seconds"),
    // total_seconds minus training_seconds.
    evalSeconds: doublePrecision("eval_seconds"),
    // Nullable because train.py prints a literal `n/a` instead of a number.
    mfuPercent: doublePrecision("mfu_percent"),
    totalTokensM: doublePrecision("total_tokens_m"),
    numSteps: integer("num_steps"),
    numParamsM: doublePrecision("num_params_m"),
    depth: integer("depth"),
    trainBatchSize: integer("train_batch_size"),
    evalBatchSize: integer("eval_batch_size"),
    activationCheckpointing: boolean("activation_checkpointing"),
    dataset: text("dataset"),
    autotuneCold: boolean("autotune_cold").notNull().default(false),
    autotuneSelectedBatchSize: integer("autotune_selected_batch_size"),
    metricsJson: jsonb("metrics_json").$type<Record<string, unknown>>(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>(),
    // executorVersion, argv, worktreeHeadBefore/After, file hashes, envKeys.
    attestation: jsonb("attestation").$type<Record<string, unknown>>(),
    logRef: text("log_ref"),
    errorExcerpt: text("error_excerpt"),
    checkpointPath: text("checkpoint_path"),
    checkpointBytes: bigint("checkpoint_bytes", { mode: "number" }),
    checkpointRetained: boolean("checkpoint_retained").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    adjudicatedAt: timestamp("adjudicated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    studySequenceUq: uniqueIndex("experiments_study_sequence_uq").on(table.studyId, table.sequence),
    studyValBpbIdx: index("experiments_study_val_bpb_idx").on(table.studyId, table.valBpb),
    // THIS PARTIAL UNIQUE INDEX IS THE SINGLE-GPU ARBITER.
    //
    // There is exactly one physical GPU per study, so at most one experiment may be in
    // the 'running' state at a time. A conditional INSERT that violates this index means
    // another experiment already holds the GPU, and the caller MUST fall through to the
    // next shortlisted idea rather than queue or overwrite. Do not attempt to reproduce
    // this arbitration in application logic alone; a read-then-write check cannot close
    // the race that this index closes atomically.
    singleRunningPerStudyUq: uniqueIndex("experiments_single_running_per_study")
      .on(table.studyId)
      .where(sql`${table.status} = 'running'`),
    studyVerdictIdx: index("experiments_study_verdict_idx").on(table.studyId, table.verdict),
    companyHeartbeatRunIdx: index("experiments_company_heartbeat_run_idx").on(table.companyId, table.heartbeatRunId),
  }),
);

// Append-only audit trail, so a branch reset is always explainable after the fact.
export const experimentVerdicts = pgTable(
  "experiment_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
    studyId: uuid("study_id").notNull().references(() => studies.id, { onDelete: "cascade" }),
    verdict: text("verdict").notNull(),
    verdictReason: text("verdict_reason").notNull(),
    previousBestValBpb: doublePrecision("previous_best_val_bpb"),
    newBestValBpb: doublePrecision("new_best_val_bpb"),
    // `adopt_simplification` advances the branch to the experiment commit WITHOUT moving
    // best_val_bpb, so a simplification win (equal val_bpb, less code) is preserved
    // instead of being erased by a pure-metric comparison.
    gitAction: text("git_action").notNull(),
    targetSha: text("target_sha"),
    reason: text("reason"),
    actorType: text("actor_type").notNull(),
    // Agent or user id depending on actor_type; the id space is not shared.
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    studyCreatedIdx: index("experiment_verdicts_study_created_idx").on(table.studyId, table.createdAt),
    experimentIdx: index("experiment_verdicts_experiment_idx").on(table.experimentId),
  }),
);
