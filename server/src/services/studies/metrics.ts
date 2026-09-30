import { renameSync, writeFileSync } from "node:fs";

/**
 * Ground truth pinned from the executor side of the autoresearch contract.
 *
 * `TIME_BUDGET_SEC` mirrors the read-only `TIME_BUDGET` constant that
 * `prepare.py` may import but not change, and `TOTAL_BATCH_SIZE` mirrors
 * `TOTAL_BATCH_SIZE = 2 ** 19` in the executor's `train.py`. Both are asserted
 * against the produced log so that an agent which edits the framework instead of
 * the model cannot buy itself a "win".
 *
 * The wall-clock figures below are measured, not guessed. Gate 0 on an RTX 4060
 * Ti (16 GB) measured five baseline runs at the same commit:
 *
 *   val_bpb  1.002385  1.006632  1.008197  1.010353  1.011264
 *   mean     1.007766 | range 0.008879 | stdev 0.003513
 *   training_seconds ~312 | num_steps 33 | mfu ~10 | peak_vram_mb 2985.3
 *   wall clock ~642s
 *
 * Two things that measurement disproved. First, evaluation over the full
 * `EVAL_TOKENS = 40 * 2 ** 19` costs about as much as training, so a whole
 * experiment is ~10.7 minutes rather than the ~5.5 the upstream README implies.
 * Second, the upstream "kill past 10 minutes" rule was written for a much faster
 * GPU and would have discarded every run on this hardware.
 *
 * The spread also matters beyond the kill timeout. A 0.003 improvement - the
 * scale `program.md` uses when discussing its simplicity criterion - is about a
 * third of the 0.0089 run-to-run range, so a study on this card has to compare
 * against a measured floor or it will advance the branch on noise. See
 * `doc/AUTORESEARCH.md`.
 *
 * These constants are therefore deliberately generous. The plausibility gate
 * exists to catch a fabricated or truncated metrics block, not to police benign
 * overshoot, so a bound that rejects a real run is worse than a loose bound.
 */
export const EXECUTOR_TRAINING_KWARGS = {
  /** Read-only time budget the executor trains under. */
  TIME_BUDGET_SEC: 300,
  /** Tokens per optimizer step: 2 ** 19. Used for the internal-consistency check. */
  TOTAL_BATCH_SIZE: 524288,
  /**
   * The executor breaks only at a step boundary once the budget is spent. On a
   * consumer GPU a single step is ~15s, so a genuine full run overshoots by up
   * to a full step: the measured baseline landed at 311.5s. The lower bound
   * absorbs first-step autograd and kernel-compile cost. The upper bound is
   * loose on purpose - it catches a run that kept going long after the budget
   * was gone, not a few seconds of overshoot.
   */
  MIN_TRAINING_SECONDS: 270,
  MAX_TRAINING_SECONDS: 480,
  /** Relative tolerance for `total_tokens_M` vs `num_steps * TOTAL_BATCH_SIZE`. */
  TOKEN_CONSISTENCY_TOLERANCE: 0.01,
  VAL_BPB_PLAUSIBLE_MIN: 0.5,
  VAL_BPB_PLAUSIBLE_MAX: 3.0,
  /**
   * Step count is the slowest-moving plausibility signal. A 300s run on a fast
   * datacenter GPU completes hundreds of steps; the measured consumer-GPU
   * baseline completed 32, because throughput was ~36k tok/s against the
   * README's 1.66M. Anything at or below 10 also forces `mfu_percent` to `n/a`,
   * since `steady_state_steps` is `max(num_steps - 10, 0)`.
   */
  MIN_NUM_STEPS: 11,
  /**
   * Hard kill for the training subprocess, measured from spawn. This must clear
   * the training budget, evaluation, and interpreter startup together, because
   * the budget deliberately excludes all three. Three times the training budget
   * leaves room for the ~360s eval the consumer-GPU baseline showed. Treat it as
   * per-machine: the study stores its own value and the leaderboard surfaces the
   * observed wall clock so an operator can tune it.
   */
  KILL_AFTER_SEC: 900,
  /**
   * Adapter-level timeout on the executor process. Must exceed KILL_AFTER_SEC so
   * the executor's own kill wins first, leaving this much headroom for the log
   * flush, the parse, and the atomic metrics write.
   */
  ADAPTER_TIMEOUT_SEC: 960,
} as const;

export interface ParsedTrainingMetrics {
  /** Printed at 6 decimals. That is the only precision that exists. */
  valBpb: number;
  trainingSeconds: number;
  /**
   * NOT wall clock. The executor's `t_start` is inside `_run_training_once`,
   * which runs after interpreter startup, runtime detection, tokenizer load and
   * the autotune pass. See `deriveTiming` for the derived split.
   */
  totalSeconds: number;
  /** MiB: `torch.cuda.max_memory_allocated() / 1024 / 1024`. */
  peakVramMb: number;
  /** Nullable on purpose. The executor prints the literal `n/a` when it cannot compute MFU. */
  mfuPercent: number | null;
  totalTokensM: number;
  numSteps: number;
  numParamsM: number;
  depth: number;
  dataset: string;
  trainBatchSize: number;
  evalBatchSize: number;
  /** The executor prints the STRING `enabled` / `disabled`. Never `Boolean(value)`. */
  activationCheckpointing: boolean;
}

export type MetricsParseErrorCode =
  | "no_summary_block"
  | "multiple_summary_blocks"
  | "summary_not_at_end"
  | "unparsable_line"
  | "smoke_test_run"
  | "missing_time_budget_line"
  | "missing_required_field"
  | "implausible_metrics";

export type ParseResult =
  | { ok: true; metrics: ParsedTrainingMetrics; provenance: Record<string, unknown> }
  | { ok: false; code: MetricsParseErrorCode; detail: string };

export interface ValidationOptions {
  /** Total VRAM of the selected GPU in bytes, or null when it could not be detected. */
  gpuTotalVramBytes: number | null;
}

export type MetricsValidationResult = { ok: true } | { ok: false; failures: string[] };

export interface TsvExperimentRow {
  gitSha: string;
  valBpb: number | null;
  memoryGb: number | null;
  verdict: "keep" | "discard" | "crash";
  description: string;
}

export interface DerivedTiming {
  preflightSeconds: number;
  evalSeconds: number;
}

const SUMMARY_MARKER = "---";

/** The summary block schema is closed: anything else in the block is a red flag. */
const KNOWN_SUMMARY_KEYS = [
  "val_bpb",
  "training_seconds",
  "total_seconds",
  "peak_vram_mb",
  "mfu_percent",
  "total_tokens_M",
  "num_steps",
  "num_params_M",
  "depth",
  "dataset",
  "train_batch_size",
  "eval_batch_size",
  "activation_checkpointing",
  "smoke_test",
] as const;

const REQUIRED_SUMMARY_KEYS = [
  "val_bpb",
  "training_seconds",
  "total_seconds",
  "peak_vram_mb",
  "mfu_percent",
  "total_tokens_M",
  "num_steps",
  "num_params_M",
  "depth",
  "dataset",
  "train_batch_size",
  "eval_batch_size",
  "activation_checkpointing",
] as const;

const NUMERIC_SUMMARY_KEYS = [
  "val_bpb",
  "training_seconds",
  "total_seconds",
  "peak_vram_mb",
  "total_tokens_M",
  "num_steps",
  "num_params_M",
  "depth",
  "train_batch_size",
  "eval_batch_size",
] as const;

const KEY_VALUE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;
const MFU_UNAVAILABLE = "n/a";
const BYTES_PER_MIB = 1024 * 1024;

/** Labels the executor prints before the summary block, mapped to camelCase provenance keys. */
const PROVENANCE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["GPU:", "gpu"],
  ["GPU VRAM:", "gpuVram"],
  ["GPU CC:", "gpuCc"],
  ["GPU profile:", "gpuProfile"],
  ["Consumer matrix support:", "consumerMatrixSupport"],
  ["TF32:", "tf32"],
  ["AMP dtype:", "ampDtype"],
  ["Vocab size:", "vocabSize"],
  ["Time budget:", "timeBudget"],
  ["Estimated FLOPs per token:", "estimatedFlopsPerToken"],
  ["Gradient accumulation steps:", "gradientAccumulationSteps"],
  ["Model config:", "modelConfig"],
];

const AUTOTUNE_LABEL = "autotuneLines";

function splitLines(log: string): string[] {
  return log.split(/\r\n|\n|\r/);
}

function isSummaryMarker(line: string): boolean {
  return line.trim() === SUMMARY_MARKER;
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampAtZero(value: number): number {
  return value > 0 ? value : 0;
}

function formatBpb(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : "0.000000";
}

/**
 * TSV is whitespace sensitive. Commas are explicitly allowed and must survive
 * (upstream descriptions legitimately contain them); tabs and newlines would
 * silently shift the column boundary, so they are removed rather than escaped.
 */
function sanitizeTsvDescription(description: string): string {
  return description
    .replace(/[\t\r\n]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Best-effort scrape of the free-form pre-block environment lines.
 *
 * Deliberately total: provenance is descriptive only, and a malformed line in
 * an untrusted log must never take down the run that produced the metrics.
 */
export function parseProvenance(log: string): Record<string, unknown> {
  const provenance: Record<string, unknown> = {};
  const autotuneLines: string[] = [];
  try {
    for (const line of splitLines(log)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/autotune/i.test(trimmed)) {
        autotuneLines.push(trimmed);
        continue;
      }
      for (const [label, key] of PROVENANCE_LABELS) {
        if (trimmed.startsWith(label)) {
          provenance[key] = trimmed.slice(label.length).trim();
          break;
        }
      }
    }
    if (autotuneLines.length > 0) provenance[AUTOTUNE_LABEL] = autotuneLines;
  } catch {
    // Intentionally swallowed: see the contract above.
  }
  return provenance;
}

/**
 * Parse the delimited metrics block the executor prints at the end of `main()`.
 *
 * The block must be the final output of the log. Trailing framework output
 * means the log we are reading is not the log the run ended with, and the
 * numbers in it can no longer be trusted as that run's result.
 */
export function parseTrainingSummary(log: string): ParseResult {
  const lines = splitLines(log);
  const markerIndices: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && isSummaryMarker(line)) markerIndices.push(index);
  }
  if (markerIndices.length === 0) {
    return {
      ok: false,
      code: "no_summary_block",
      detail: `log contains no "${SUMMARY_MARKER}" summary marker`,
    };
  }
  if (markerIndices.length > 1) {
    return {
      ok: false,
      code: "multiple_summary_blocks",
      detail: `log contains ${markerIndices.length} "${SUMMARY_MARKER}" summary markers; exactly one is expected`,
    };
  }

  const markerIndex = markerIndices[0] as number;
  const prefix = lines.slice(0, markerIndex);
  const tail = lines.slice(markerIndex + 1);

  // Proves prepare.py's read-only TIME_BUDGET constant was left alone, and that
  // the run really was a full-budget run rather than a truncated restart.
  const hasTimeBudgetLine = prefix.some((line) => line.trim().startsWith("Time budget:"));
  if (!hasTimeBudgetLine) {
    return {
      ok: false,
      code: "missing_time_budget_line",
      detail: `no "Time budget:" line before the summary block; expected ${EXECUTOR_TRAINING_KWARGS.TIME_BUDGET_SEC}s`,
    };
  }

  const pairs = new Map<string, string>();
  const trailingGarbage: string[] = [];
  for (const line of tail) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = KEY_VALUE_PATTERN.exec(trimmed);
    if (!match) {
      // Buffer instead of failing immediately. If a complete, well-formed block
      // precedes this, the block simply is not at the end of the log. If more
      // metric lines follow, the block itself is corrupt.
      trailingGarbage.push(trimmed);
      continue;
    }
    if (trailingGarbage.length > 0) {
      return {
        ok: false,
        code: "unparsable_line",
        detail: `metric line follows unparsable output inside the summary block: ${trailingGarbage[0]}`,
      };
    }
    const key = match[1] as string;
    if (!(KNOWN_SUMMARY_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        code: "unparsable_line",
        detail: `unknown key "${key}" inside the summary block`,
      };
    }
    pairs.set(key, (match[2] as string).trim());
  }

  if (pairs.has("smoke_test")) {
    // train.py only prints this under --smoke-test, where eval tokens are ~1/40th
    // of normal. Its val_bpb is not comparable to a real run, so it can never be
    // allowed to become a score.
    return {
      ok: false,
      code: "smoke_test_run",
      detail: "summary block reports a smoke test; smoke-test val_bpb is not comparable to a full run",
    };
  }

  if (trailingGarbage.length > 0) {
    const complete = REQUIRED_SUMMARY_KEYS.every((key) => pairs.has(key));
    if (complete) {
      return {
        ok: false,
        code: "summary_not_at_end",
        detail: `summary block is followed by further output: ${trailingGarbage[0]}`,
      };
    }
    return {
      ok: false,
      code: "unparsable_line",
      detail: `unparsable line inside the summary block: ${trailingGarbage[0]}`,
    };
  }

  const missing = REQUIRED_SUMMARY_KEYS.filter((key) => !pairs.has(key));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing_required_field",
      detail: `summary block is missing required field(s): ${missing.join(", ")}`,
    };
  }

  const numbers: Partial<Record<(typeof NUMERIC_SUMMARY_KEYS)[number], number>> = {};
  for (const key of NUMERIC_SUMMARY_KEYS) {
    const raw = pairs.get(key) as string;
    const parsed = Number(raw);
    if (raw === "" || !Number.isFinite(parsed)) {
      return {
        ok: false,
        code: "unparsable_line",
        detail: `field "${key}" is not a finite number: ${JSON.stringify(raw)}`,
      };
    }
    numbers[key] = parsed;
  }

  const mfuRaw = pairs.get("mfu_percent") as string;
  // `n/a` means "the executor could not compute MFU" (unknown peak FLOPs for the
  // GPU name, zero steady-state steps, or zero training time). It is NOT zero,
  // and collapsing it to 0 would fabricate a catastrophic efficiency result.
  const mfuPercent = mfuRaw.toLowerCase() === MFU_UNAVAILABLE ? null : Number(mfuRaw);
  if (mfuPercent !== null && !Number.isFinite(mfuPercent)) {
    return {
      ok: false,
      code: "unparsable_line",
      detail: `field "mfu_percent" is neither a finite number nor "${MFU_UNAVAILABLE}": ${JSON.stringify(mfuRaw)}`,
    };
  }

  const checkpointingRaw = pairs.get("activation_checkpointing") as string;
  // Explicit mapping. `Boolean("disabled")` is true, which would credit a run
  // for checkpointing it never enabled.
  let activationCheckpointing: boolean;
  if (checkpointingRaw === "enabled") {
    activationCheckpointing = true;
  } else if (checkpointingRaw === "disabled") {
    activationCheckpointing = false;
  } else {
    return {
      ok: false,
      code: "unparsable_line",
      detail: `field "activation_checkpointing" must be "enabled" or "disabled", got ${JSON.stringify(checkpointingRaw)}`,
    };
  }

  const metrics: ParsedTrainingMetrics = {
    valBpb: numbers.val_bpb as number,
    trainingSeconds: numbers.training_seconds as number,
    totalSeconds: numbers.total_seconds as number,
    peakVramMb: numbers.peak_vram_mb as number,
    mfuPercent,
    totalTokensM: numbers.total_tokens_M as number,
    numSteps: numbers.num_steps as number,
    numParamsM: numbers.num_params_M as number,
    depth: numbers.depth as number,
    dataset: pairs.get("dataset") as string,
    trainBatchSize: numbers.train_batch_size as number,
    evalBatchSize: numbers.eval_batch_size as number,
    activationCheckpointing,
  };

  return { ok: true, metrics, provenance: parseProvenance(log) };
}

/**
 * Parse plus plausibility gate in one call.
 *
 * The executor wants a single accept/reject decision: a run either produced a
 * trustworthy metric or it did not. `implausible_metrics` is the bridge between
 * the two stages, so a caller that forgets the second step fails closed rather
 * than accepting whatever parsed.
 */
export function parseAndValidateTrainingSummary(
  log: string,
  opts: ValidationOptions,
): ParseResult {
  const parsed = parseTrainingSummary(log);
  if (!parsed.ok) return parsed;

  const validation = validateTrainingMetrics(parsed.metrics, opts);
  if (!validation.ok) {
    return {
      ok: false,
      code: "implausible_metrics",
      detail: validation.failures.join("; "),
    };
  }
  return parsed;
}

/**
 * Plausibility gate applied after a successful parse.
 *
 * Collects every failure rather than short-circuiting, so an operator reading
 * the rejection sees the whole picture instead of fixing one field at a time.
 */
export function validateTrainingMetrics(
  metrics: ParsedTrainingMetrics,
  opts: ValidationOptions,
): MetricsValidationResult {
  const failures: string[] = [];

  // Catches a run that bailed out of the loop early (crash, OOM, agent-driven
  // sys.exit) but still reached the print statement, and catches a block whose
  // training_seconds was typed in by hand.
  if (
    !Number.isFinite(metrics.trainingSeconds) ||
    metrics.trainingSeconds < EXECUTOR_TRAINING_KWARGS.MIN_TRAINING_SECONDS ||
    metrics.trainingSeconds > EXECUTOR_TRAINING_KWARGS.MAX_TRAINING_SECONDS
  ) {
    failures.push(
      `training_seconds ${metrics.trainingSeconds} is outside [${EXECUTOR_TRAINING_KWARGS.MIN_TRAINING_SECONDS}, ${EXECUTOR_TRAINING_KWARGS.MAX_TRAINING_SECONDS}]`,
    );
  }

  // A real budgeted run completes hundreds of steps. Single digits means the
  // loop exited on something other than the time budget.
  if (!Number.isFinite(metrics.numSteps) || metrics.numSteps < EXECUTOR_TRAINING_KWARGS.MIN_NUM_STEPS) {
    failures.push(
      `num_steps ${metrics.numSteps} is below the minimum ${EXECUTOR_TRAINING_KWARGS.MIN_NUM_STEPS}`,
    );
  }

  // Catches a fabricated or wildly misconfigured loss (untrained model, wrong
  // tokenizer, or a number copied out of another run's log).
  if (
    !Number.isFinite(metrics.valBpb) ||
    metrics.valBpb < EXECUTOR_TRAINING_KWARGS.VAL_BPB_PLAUSIBLE_MIN ||
    metrics.valBpb > EXECUTOR_TRAINING_KWARGS.VAL_BPB_PLAUSIBLE_MAX
  ) {
    failures.push(
      `val_bpb ${metrics.valBpb} is outside the plausible range [${EXECUTOR_TRAINING_KWARGS.VAL_BPB_PLAUSIBLE_MIN}, ${EXECUTOR_TRAINING_KWARGS.VAL_BPB_PLAUSIBLE_MAX}]`,
    );
  }

  // peak_vram_mb must be positive: a run that never touched the GPU reported no
  // memory, which means it was not the run we think it was. The upper bound is
  // only enforced when the operator told us the card size; 5% absorbs allocator
  // rounding and the difference between reserved and reported capacity.
  if (!Number.isFinite(metrics.peakVramMb) || metrics.peakVramMb <= 0) {
    failures.push(`peak_vram_mb ${metrics.peakVramMb} must be greater than 0`);
  } else if (opts.gpuTotalVramBytes !== null && Number.isFinite(opts.gpuTotalVramBytes)) {
    const totalMiB = opts.gpuTotalVramBytes / BYTES_PER_MIB;
    if (metrics.peakVramMb > totalMiB * 1.05) {
      failures.push(
        `peak_vram_mb ${metrics.peakVramMb} exceeds the detected GPU capacity of ${roundToTenth(totalMiB)} MiB`,
      );
    }
  }

  // The forgery check. total_tokens is exactly step * TOTAL_BATCH_SIZE, so the
  // two printed numbers have to agree. An agent that hand-writes a metrics block
  // almost certainly invents one and forgets to make the other consistent.
  const expectedTokensM = (metrics.numSteps * EXECUTOR_TRAINING_KWARGS.TOTAL_BATCH_SIZE) / 1e6;
  if (!Number.isFinite(metrics.totalTokensM) || expectedTokensM <= 0) {
    failures.push(
      `cannot check token consistency: total_tokens_M ${metrics.totalTokensM} against expected ${expectedTokensM}`,
    );
  } else {
    const relativeError = Math.abs(metrics.totalTokensM - expectedTokensM) / expectedTokensM;
    if (relativeError > EXECUTOR_TRAINING_KWARGS.TOKEN_CONSISTENCY_TOLERANCE) {
      failures.push(
        `total_tokens_M ${metrics.totalTokensM} disagrees with num_steps * TOTAL_BATCH_SIZE (${roundToTenth(expectedTokensM)} M) by ${(relativeError * 100).toFixed(2)}%, above the ${EXECUTOR_TRAINING_KWARGS.TOKEN_CONSISTENCY_TOLERANCE * 100}% tolerance`,
      );
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true };
}

/**
 * Split wall clock into the phases the executor does not print separately.
 *
 * `total_seconds` starts inside `_run_training_once`, after interpreter startup,
 * `detect_runtime()`, tokenizer load and the autotune pass. Anything outside it
 * is preflight. The tail after training is eval.
 */
export function deriveTiming(
  metrics: ParsedTrainingMetrics,
  wallClockSeconds: number,
): DerivedTiming {
  return {
    preflightSeconds: roundToTenth(clampAtZero(wallClockSeconds - metrics.totalSeconds)),
    evalSeconds: roundToTenth(clampAtZero(metrics.totalSeconds - metrics.trainingSeconds)),
  };
}

/**
 * Render the upstream `results.tsv` contract, byte for byte.
 *
 * WARNING for callers computing a best score: the crash sentinel renders as
 * `0.000000`, which sorts as the BEST possible val_bpb under both `min()` and a
 * naive lexicographic sort. `bestValBpb` updates must therefore filter on
 * `verdict !== "crash"` before taking a minimum. Upstream calls this column
 * `memory_gb`; it is really GiB derived from the MiB peak. The name is kept for
 * upstream fidelity.
 */
export function renderResultsTsv(rows: TsvExperimentRow[]): string {
  const lines = ["commit\tval_bpb\tmemory_gb\tstatus\tdescription"];
  for (const row of rows) {
    lines.push(
      [
        row.gitSha.slice(0, 7),
        formatBpb(row.valBpb as number),
        Number.isFinite(row.memoryGb as number) ? (row.memoryGb as number).toFixed(1) : "0.0",
        row.verdict,
        sanitizeTsvDescription(row.description),
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Regenerate `results.tsv` atomically rather than appending a row.
 *
 * The metrics and the row are written at two different moments. If the process
 * dies in between, an appended file is permanently missing a row, and a reader
 * cannot tell a missing experiment from an experiment that never ran. Full
 * regeneration from the durable experiment records self-heals that gap, and the
 * write-then-rename means no reader ever observes a half-written file.
 */
export function writeResultsTsvAtomic(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  // Node's synchronous `os.replace`: same-directory rename, atomically replacing
  // any existing target, so the file is never truncated in place.
  renameSync(temporaryPath, filePath);
}