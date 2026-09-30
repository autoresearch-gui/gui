import type {
  BaselineSource,
  ExperimentGitAction,
  ExperimentKind,
  ExperimentStatus,
  ExperimentVerdict,
  ExperimentVerdictReason,
  IdeaExpectedDirection,
  IdeaFamily,
  IdeaStatus,
  StudyStatus,
} from "../constants.js";

export interface StudyGpuProfile {
  gpuName: string;
  totalVramBytes: number;
  computeCapability: string;
  tf32Enabled: boolean;
  ampDtype: string;
  profileName: string;
  /**
   * False when the training config relies on kernel paths that only exist for
   * datacenter cards. The framework picks a safer profile in that case.
   */
  consumerSupported: boolean;
  autotuneCachePath: string;
  capturedAt: Date;
}

export interface Study {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  /** Short slug that also names the `autoresearch/<tag>` git branch. */
  tag: string;
  branchName: string;
  /** Ref the study branch was cut from. */
  baseRef: string;
  repoPath: string;
  protocolDocumentId: string | null;
  protocolRevision: number | null;
  status: StudyStatus;
  gpuProfileJson: StudyGpuProfile | null;
  venvPath: string | null;
  cacheDir: string | null;
  timeBudgetSec: number;
  /** Wall time after which a single experiment is killed. */
  killAfterSec: number;
  isBaselineRequired: boolean;
  baselineValBpb: number | null;
  baselineGitSha: string | null;
  baselineSource: BaselineSource | null;
  baselineNote: string | null;
  /**
   * Smallest val_bpb delta treated as a real change. A delta at or below this
   * floor is `within_noise_equal`, not an improvement.
   */
  noiseFloorBpb: number | null;
  bestValBpb: number | null;
  bestExperimentId: string | null;
  targetValBpb: number | null;
  experimentCount: number;
  keepCount: number;
  discardCount: number;
  crashCount: number;
  /** Drives the crash backoff / idea retry gate. */
  consecutiveCrashes: number;
  consecutiveDiscards: number;
  lastKeptSha: string | null;
  lastActivityAt: Date | null;
  resultsTsvPath: string | null;
  keepLastNKeeps: number;
  exploreEveryN: number;
  minOpenIdeas: number;
  maxCrashRetriesPerIdea: number;
  maxSimplificationKeepsPerWindow: number;
  createdAt: Date;
  startedAt: Date | null;
  concludedAt: Date | null;
}

export interface ExperimentAttestation {
  executorVersion: string;
  argv: string[];
  worktreePath: string;
  /** Provenance: the worktree head must not move underneath a running experiment. */
  worktreeHeadBefore: string;
  worktreeHeadAfter: string;
  trainPySha256: string;
  preparePySha256: string;
  pyprojectSha256: string;
  uvLockSha256: string;
  resolvedPythonExe: string;
  /** Environment variable names only. Values are never recorded. */
  envKeys: string[];
  startedAt: Date;
  killedBy: string | null;
}

export interface ExperimentProvenance {
  gpuName: string;
  gpuVramGb: number;
  gpuCc: string;
  gpuProfile: string;
  consumerMatrixSupport: boolean;
  tf32: boolean;
  ampDtype: string;
  vocabSize: number;
  timeBudgetLine: string;
  flopsPerToken: number;
  gradAccumSteps: number;
  modelConfig: Record<string, unknown>;
  autotuneSelected: boolean;
}

export interface Experiment {
  id: string;
  companyId: string;
  studyId: string;
  issueId: string | null;
  ideaId: string | null;
  /** 1-based position within the study; fixes the results.tsv row order. */
  sequence: number;
  kind: ExperimentKind;
  description: string;
  hypothesis: string | null;
  gitSha: string | null;
  heartbeatRunId: string | null;
  status: ExperimentStatus;
  verdict: ExperimentVerdict | null;
  verdictReason: ExperimentVerdictReason | null;
  /** True when this verdict moved `bestValBpb`. A simplification win does not. */
  metricCredit: boolean;
  complexityDeltaLines: number | null;
  valBpb: number | null;
  /** val_bpb minus the study best at the moment this experiment finished. */
  deltaVsBestAtTime: number | null;
  peakVramMb: number | null;
  memoryGb: number | null;
  trainingSeconds: number | null;
  totalSeconds: number | null;
  preflightSeconds: number | null;
  evalSeconds: number | null;
  mfuPercent: number | null;
  totalTokensM: number | null;
  numSteps: number | null;
  numParamsM: number | null;
  depth: number | null;
  trainBatchSize: number | null;
  evalBatchSize: number | null;
  activationCheckpointing: boolean | null;
  dataset: string | null;
  autotuneCold: boolean;
  autotuneSelectedBatchSize: number | null;
  metricsJson: Record<string, unknown> | null;
  provenance: ExperimentProvenance | null;
  attestation: ExperimentAttestation | null;
  logRef: string | null;
  errorExcerpt: string | null;
  checkpointPath: string | null;
  checkpointBytes: number | null;
  checkpointRetained: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  adjudicatedAt: Date | null;
  createdAt: Date;
}

export interface ExperimentIdeaScores {
  novelty: number;
  expectedGain: number;
  simplicity: number;
  risk: number;
}

export interface ExperimentIdea {
  id: string;
  companyId: string;
  studyId: string;
  issueId: string | null;
  proposingAgentId: string;
  title: string;
  rationale: string;
  expectedDirection: IdeaExpectedDirection;
  family: IdeaFamily | null;
  patchFormat: "unified_diff" | "full_file";
  patchBody: string;
  /** Study head the patch was authored against. */
  basedOnSha: string | null;
  predictedValBpbDelta: number | null;
  scores: ExperimentIdeaScores;
  scoreTotal: number;
  /** Adversarial critic pass; null while uncritiqued. */
  criticScore: number | null;
  status: IdeaStatus;
  rejectionReason: string | null;
  decidedByType: "agent" | "user" | "system" | null;
  decidedById: string | null;
  decidedAt: Date | null;
  attemptCount: number;
  createdAt: Date;
}

export interface ExperimentVerdictRecord {
  id: string;
  companyId: string;
  experimentId: string;
  studyId: string;
  verdict: ExperimentVerdict;
  verdictReason: ExperimentVerdictReason;
  previousBestValBpb: number | null;
  newBestValBpb: number | null;
  gitAction: ExperimentGitAction;
  targetSha: string | null;
  reason: string | null;
  actorType: "agent" | "user" | "system";
  actorId: string;
  createdAt: Date;
}

export interface StudySetupCheck {
  key:
    | "uv_on_path"
    | "cache_artifacts"
    | "venv_resolves"
    | "branch_absent"
    | "results_tsv"
    | "executor_present";
  label: string;
  ok: boolean;
  detail: string;
}

export interface StudyLeaderboardRow {
  experimentId: string;
  sequence: number;
  kind: ExperimentKind;
  description: string;
  valBpb: number | null;
  deltaVsBestAtTime: number | null;
  memoryGb: number | null;
  trainingSeconds: number | null;
  numParamsM: number | null;
  depth: number | null;
  status: ExperimentStatus;
  verdict: ExperimentVerdict | null;
  verdictReason: ExperimentVerdictReason | null;
  complexityDeltaLines: number | null;
  metricCredit: boolean;
  gitSha: string | null;
  isCurrentBest: boolean;
  isBranchHead: boolean;
  llmCostCents: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface StudyProgressPoint {
  sequence: number;
  valBpb: number | null;
  memoryGb: number | null;
  verdict: ExperimentVerdict | null;
  isBest: boolean;
  gpuTotalVramBytes: number | null;
  finishedAt: Date | null;
}

export interface StudyMorningReport {
  studyId: string;
  generatedAt: Date;
  windowStartedAt: Date;
  windowEndedAt: Date;
  experimentCount: number;
  keptCount: number;
  discardedCount: number;
  crashedCount: number;
  baselineValBpb: number | null;
  bestValBpb: number | null;
  /** bestValBpb minus baselineValBpb; negative is an improvement. */
  improvementAbs: number | null;
  improvementPercent: number | null;
  bestExperimentId: string | null;
  bestGitSha: string | null;
  /** Command that checks the branch out at the best commit. */
  bestCheckoutCommand: string | null;
  noiseFloorBpb: number | null;
  bestCommitIsBranchHead: boolean;
  topKept: StudyLeaderboardRow[];
  winningIdeas: ExperimentIdea[];
  rejectedIdeaCount: number;
  consecutiveCrashes: number;
  consecutiveDiscards: number;
  lastActivityAt: Date | null;
  outcome: "improved" | "no_improvement" | "stalled" | "insufficient_data";
  notes: string[];
}