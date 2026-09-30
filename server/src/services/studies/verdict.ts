/**
 * Deterministic adjudication for a single autoresearch experiment.
 *
 * No LLM runs in this path. The agent proposes a change; this module decides
 * whether that change becomes the branch's new best, and the answer has to be
 * reproducible from the record alone.
 */

export type Verdict = "keep" | "discard" | "crash";
export type GitAction = "advanced" | "reset_to_sha" | "adopt_simplification";
export type VerdictReason =
  | "val_bpb_improved"
  | "val_bpb_regressed"
  | "within_noise_equal"
  | "simplification_win";

export interface VerdictInput {
  /** null when the run crashed or produced no parsable metric. */
  valBpb: number | null;
  /** Net line delta of the change. Negative means the model got simpler. */
  complexityDeltaLines: number | null;
  /** Best val_bpb before this run, or null when no successful run exists yet. */
  bestValBpb: number | null;
  /** Half-width of acceptable run-to-run variation, from `computeNoiseFloor`. */
  noiseFloorBpb: number | null;
  isBaseline: boolean;
  simplificationKeepsInWindow: number;
  maxSimplificationKeepsPerWindow: number;
  /** Operator-imposed hard limit on val_bpb. Overrides every other rule. */
  valBpbCeiling: number | null;
}

export interface VerdictDecision {
  verdict: Verdict;
  verdictReason: VerdictReason;
  gitAction: GitAction;
  /** Whether this run may count toward the experiment's improvement tally. */
  metricCredit: boolean;
  /** Whether this run becomes the new `bestValBpb`. */
  updatesBest: boolean;
  simplificationKeep: boolean;
  /** One sentence a human can read to understand the call. */
  explanation: string;
}

/**
 * Run-to-run spread of 3 identical baseline runs.
 *
 * Without this, "0.003 better" and "the GPU was having a bad day" are the same
 * observation, and the framework will happily advance the branch on noise. The
 * spread is the width of the band inside which a change is neither a win nor a
 * loss.
 */
export function computeNoiseFloor(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return null;
  let min = finite[0] as number;
  let max = finite[0] as number;
  for (const value of finite) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min;
}

export function resolveVerdict(input: VerdictInput): VerdictDecision {
  const {
    valBpb,
    complexityDeltaLines,
    bestValBpb,
    noiseFloorBpb,
    isBaseline,
    simplificationKeepsInWindow,
    maxSimplificationKeepsPerWindow,
    valBpbCeiling,
  } = input;

  // No metric means no evidence. The branch cannot move forward on a run that
  // did not produce a number, so the working tree goes back to the last good sha.
  if (valBpb === null) {
    return {
      verdict: "crash",
      verdictReason: "val_bpb_regressed",
      gitAction: "reset_to_sha",
      metricCredit: false,
      updatesBest: false,
      simplificationKeep: false,
      explanation: "The run did not produce a val_bpb, so it cannot be scored and the branch is reset to the last known good commit.",
    };
  }

  // Operator ceiling. Checked before every other rule, including the baseline
  // path: a policy limit is not a judgement call the agent can out-argue.
  if (valBpbCeiling !== null && valBpb > valBpbCeiling) {
    return {
      verdict: "discard",
      verdictReason: "val_bpb_regressed",
      gitAction: "reset_to_sha",
      metricCredit: false,
      updatesBest: false,
      simplificationKeep: false,
      explanation: `val_bpb ${valBpb} is above the operator ceiling of ${valBpbCeiling}, so the change is discarded regardless of its other properties.`,
    };
  }

  // First successful run. There is nothing to compare against yet, so the only
  // honest verdict is that this number is the incumbent.
  if (bestValBpb === null) {
    return {
      verdict: "keep",
      verdictReason: "val_bpb_improved",
      gitAction: "advanced",
      metricCredit: true,
      updatesBest: true,
      simplificationKeep: false,
      explanation: `val_bpb ${valBpb} is the first successfully measured result, so it becomes the baseline the branch is compared against.`,
    };
  }

  // A baseline run exists to characterize the spread, not to win. It is kept and
  // credited so the record stays complete, and it only becomes the incumbent
  // when it is strictly better than the current best.
  if (isBaseline) {
    const updatesBest = valBpb < bestValBpb;
    return {
      verdict: "keep",
      verdictReason: "val_bpb_improved",
      gitAction: "advanced",
      metricCredit: true,
      updatesBest,
      simplificationKeep: false,
      explanation: updatesBest
        ? `Baseline run at val_bpb ${valBpb} beats the incumbent ${bestValBpb} and is adopted as the new best.`
        : `Baseline run at val_bpb ${valBpb} is kept to measure spread against the incumbent ${bestValBpb}, but it does not become the best.`,
    };
  }

  const floor = noiseFloorBpb === null ? 0 : noiseFloorBpb;

  if (valBpb < bestValBpb - floor) {
    return {
      verdict: "keep",
      verdictReason: "val_bpb_improved",
      gitAction: "advanced",
      metricCredit: true,
      updatesBest: true,
      simplificationKeep: false,
      explanation: `val_bpb ${valBpb} beats the incumbent ${bestValBpb} by more than the ${floor} noise floor, so the branch advances.`,
    };
  }

  // A genuine regression is never rewarded, no matter how much simpler the code
  // got. Letting a simplification keep ride along with a worse model is how the
  // search trades a real loss for a tidy diff.
  if (valBpb > bestValBpb + floor) {
    return {
      verdict: "discard",
      verdictReason: "val_bpb_regressed",
      gitAction: "reset_to_sha",
      metricCredit: false,
      updatesBest: false,
      simplificationKeep: false,
      explanation: `val_bpb ${valBpb} regresses past the incumbent ${bestValBpb} by more than the ${floor} noise floor, so the branch is reset even though the code is simpler.`,
    };
  }

  // Inside the noise band: neither a win nor a loss. The only remaining value is
  // a strictly simpler model at the same score.
  const simplificationBudgetLeft = simplificationKeepsInWindow < maxSimplificationKeepsPerWindow;
  if (complexityDeltaLines !== null && complexityDeltaLines < 0 && simplificationBudgetLeft) {
    return {
      verdict: "keep",
      verdictReason: "simplification_win",
      gitAction: "adopt_simplification",
      // No metric credit: the score did not move, so the change must not be
      // counted as an improvement toward the research goal.
      metricCredit: false,
      updatesBest: false,
      simplificationKeep: true,
      explanation: `val_bpb ${valBpb} is within the ${floor} noise floor of the incumbent ${bestValBpb}, but the change removes ${Math.abs(complexityDeltaLines)} lines, so the simpler version is adopted without claiming a metric win.`,
    };
  }

  // Either the change made the model bigger, or the simplification budget for
  // this window is spent. The budget is a hard cap rather than a preference
  // because an agent with a free simplification keep can always strip the model
  // down to nothing: delete the layers, and "simpler" wins forever while the
  // score quietly rots inside the noise band.
  const exhausted = simplificationKeepsInWindow >= maxSimplificationKeepsPerWindow;
  return {
    verdict: "discard",
    verdictReason: "within_noise_equal",
    gitAction: "reset_to_sha",
    metricCredit: false,
    updatesBest: false,
    simplificationKeep: false,
    explanation: exhausted
      ? `val_bpb ${valBpb} matches the incumbent ${bestValBpb} within noise and the window's ${maxSimplificationKeepsPerWindow} simplification keep(s) are already spent, so the branch is reset.`
      : `val_bpb ${valBpb} matches the incumbent ${bestValBpb} within noise without reducing complexity, so the branch is reset.`,
  };
}