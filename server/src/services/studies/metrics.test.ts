import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EXECUTOR_TRAINING_KWARGS,
  deriveTiming,
  parseAndValidateTrainingSummary,
  parseProvenance,
  parseTrainingSummary,
  renderResultsTsv,
  validateTrainingMetrics,
  writeResultsTsvAtomic,
  type ParsedTrainingMetrics,
  type TsvExperimentRow,
} from "./metrics.js";

/** The environment banner the executor prints before it starts training. */
const LOG_PREFIX = [
  "Autoresearch pretraining script. Single-GPU, single-file.",
  "Runtime: pytorch 2.9.1+cu128 (flash-attn built)",
  "GPU: NVIDIA GeForce RTX 5090",
  "GPU VRAM: 31.4 GB",
  "GPU CC: 12.0",
  "GPU profile: blackwell consumer (sm_120)",
  "Consumer matrix support: yes",
  "TF32: enabled",
  "AMP dtype: bfloat16",
  "Loading tokenizer: tinystories",
  "Vocab size: 50,257",
  "Estimated FLOPs per token: 4.123456e+10",
  "Running consumer GPU autotune in eager mode...",
  "Autotune probe: train_batch_size=1, checkpointing=enabled",
  "Autotune probe: train_batch_size=2, checkpointing=enabled",
  "Autotune selected candidate: train_batch_size=8, checkpointing=enabled",
  "Time budget: 300s",
  "Gradient accumulation steps: 65536",
  "  step     1/  953  loss 11.5129  tok/s  524288  mfu  0.12%",
  "  step   500/  953  loss  2.1044  tok/s  524288  mfu  38.91%",
  "  step   953/  953  loss  1.3812  tok/s  524288  mfu  39.77%",
  "Training complete",
].join("\n");

/** The exact block from the executor, alignment included. */
const REAL_BLOCK = [
  "---",
  "val_bpb:          0.997900",
  "training_seconds: 300.1",
  "total_seconds:    325.9",
  "peak_vram_mb:     45060.2",
  "mfu_percent:      39.80",
  "total_tokens_M:   499.6",
  "num_steps:        953",
  "num_params_M:     50.3",
  "depth:            8",
  "dataset:          tinystories",
  "train_batch_size: 8",
  "eval_batch_size:  4",
  "activation_checkpointing: enabled",
].join("\n");

const BLOCK_WITHOUT_TIME_BUDGET_PREFIX = LOG_PREFIX.split("\n")
  .filter((line) => !line.startsWith("Time budget:"))
  .join("\n");

function logOf(block: string, prefix: string = LOG_PREFIX): string {
  return `${prefix}\n${block}\n`;
}

function cleanMetrics(): ParsedTrainingMetrics {
  const result = parseTrainingSummary(logOf(REAL_BLOCK));
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.code} ${result.detail}`);
  return result.metrics;
}

describe("parseTrainingSummary", () => {
  it("parses the executor's summary block into typed metrics", () => {
    const result = parseTrainingSummary(logOf(REAL_BLOCK));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metrics).toEqual({
      valBpb: 0.9979,
      trainingSeconds: 300.1,
      totalSeconds: 325.9,
      peakVramMb: 45060.2,
      mfuPercent: 39.8,
      totalTokensM: 499.6,
      numSteps: 953,
      numParamsM: 50.3,
      depth: 8,
      dataset: "tinystories",
      trainBatchSize: 8,
      evalBatchSize: 4,
      activationCheckpointing: true,
    });
  });

  it("scrapes the environment banner into camelCase provenance", () => {
    const provenance = parseProvenance(LOG_PREFIX);
    expect(provenance).toMatchObject({
      gpu: "NVIDIA GeForce RTX 5090",
      gpuVram: "31.4 GB",
      gpuCc: "12.0",
      gpuProfile: "blackwell consumer (sm_120)",
      consumerMatrixSupport: "yes",
      tf32: "enabled",
      ampDtype: "bfloat16",
      vocabSize: "50,257",
      timeBudget: "300s",
      estimatedFlopsPerToken: "4.123456e+10",
      gradientAccumulationSteps: "65536",
    });
    expect(provenance.autotuneLines).toEqual([
      "Running consumer GPU autotune in eager mode...",
      "Autotune probe: train_batch_size=1, checkpointing=enabled",
      "Autotune probe: train_batch_size=2, checkpointing=enabled",
      "Autotune selected candidate: train_batch_size=8, checkpointing=enabled",
    ]);
  });

  it("reads mfu_percent n/a as null rather than zero", () => {
    const result = parseTrainingSummary(
      logOf(REAL_BLOCK.replace("mfu_percent:      39.80", "mfu_percent:      n/a")),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metrics.mfuPercent).toBeNull();
  });

  it("reads activation_checkpointing disabled as false", () => {
    const result = parseTrainingSummary(
      logOf(REAL_BLOCK.replace("activation_checkpointing: enabled", "activation_checkpointing: disabled")),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metrics.activationCheckpointing).toBe(false);
  });

  it("rejects a truncated log with no summary marker", () => {
    const result = parseTrainingSummary(`${LOG_PREFIX}\n  step  120/  953  loss  3.0112`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_summary_block");
  });

  it("rejects a log carrying two summary blocks", () => {
    const result = parseTrainingSummary(logOf(`${REAL_BLOCK}\n${REAL_BLOCK}`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("multiple_summary_blocks");
  });

  it("rejects a summary block that is followed by more output", () => {
    const result = parseTrainingSummary(
      logOf(`${REAL_BLOCK}\nWrote checkpoint to /runs/ckpt.pt`),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("summary_not_at_end");
  });

  it("rejects a log with no Time budget line before the block", () => {
    const result = parseTrainingSummary(logOf(REAL_BLOCK, BLOCK_WITHOUT_TIME_BUDGET_PREFIX));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing_time_budget_line");
  });

  it("rejects a smoke test run outright", () => {
    const result = parseTrainingSummary(logOf(`${REAL_BLOCK}\nsmoke_test:       true`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("smoke_test_run");
  });

  it("rejects a garbage line inside the block", () => {
    const result = parseTrainingSummary(
      logOf(REAL_BLOCK.replace("num_steps:        953", "num_steps:        953\n!!! cuda went away")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unparsable_line");
  });

  it("rejects a block missing a required field", () => {
    const result = parseTrainingSummary(
      logOf(REAL_BLOCK.replace("depth:            8\n", "")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing_required_field");
  });

  it("rejects an unknown key smuggled into the block", () => {
    const result = parseTrainingSummary(logOf(`${REAL_BLOCK}\nval_bpb_override: 0.1`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unparsable_line");
  });
});

describe("validateTrainingMetrics", () => {
  const noGpu = { gpuTotalVramBytes: null };

  it("accepts a legitimate full-budget run whose mfu is n/a", () => {
    const parsed = parseTrainingSummary(
      logOf(REAL_BLOCK.replace("mfu_percent:      39.80", "mfu_percent:      n/a")),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateTrainingMetrics(parsed.metrics, noGpu)).toEqual({ ok: true });
  });

  it("rejects a forged block whose token count disagrees with its step count", () => {
    const parsed = parseTrainingSummary(
      logOf(REAL_BLOCK.replace("total_tokens_M:   499.6", "total_tokens_M:   120.0")),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = validateTrainingMetrics(parsed.metrics, noGpu);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("total_tokens_M 120 disagrees");
  });

  it("rejects a run that stopped long before the time budget", () => {
    const parsed = parseTrainingSummary(
      logOf(
        REAL_BLOCK.replace("training_seconds: 300.1", "training_seconds: 12.0").replace(
          "total_seconds:    325.9",
          "total_seconds:    20.4",
        ),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = validateTrainingMetrics(parsed.metrics, noGpu);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("training_seconds 12 is outside");
  });

  it("rejects a run that completed too few steps", () => {
    const parsed = parseTrainingSummary(
      logOf(
        REAL_BLOCK
          .replace("num_steps:        953", "num_steps:        4")
          .replace("total_tokens_M:   499.6", "total_tokens_M:   2.1"),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = validateTrainingMetrics(parsed.metrics, noGpu);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("num_steps 4 is below the minimum 11");
  });

  it("rejects a peak vram reading larger than the detected card", () => {
    const result = validateTrainingMetrics(cleanMetrics(), { gpuTotalVramBytes: 32 * 1024 ** 3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("exceeds the detected GPU capacity");
  });

  it("collects every failure instead of stopping at the first", () => {
    const result = validateTrainingMetrics(
      {
        ...cleanMetrics(),
        valBpb: 0.01,
        trainingSeconds: 12,
        numSteps: 4,
        peakVramMb: 0,
      },
      noGpu,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(5);
    expect(result.failures.join("\n")).toContain("val_bpb 0.01 is outside");
  });
});

describe("deriveTiming", () => {
  it("splits wall clock into preflight and eval", () => {
    expect(deriveTiming(cleanMetrics(), 402.4)).toEqual({
      preflightSeconds: 76.5,
      evalSeconds: 25.8,
    });
  });

  it("clamps a noisy wall clock at zero instead of going negative", () => {
    expect(deriveTiming(cleanMetrics(), 100)).toEqual({
      preflightSeconds: 0,
      evalSeconds: 25.8,
    });
  });
});

describe("renderResultsTsv", () => {
  const sha = "3f9a1c2b7d4e5f60718293a4b5c6d7e8f9012345";

  it("emits the exact upstream header for an empty row set", () => {
    expect(renderResultsTsv([])).toBe("commit\tval_bpb\tmemory_gb\tstatus\tdescription\n");
  });

  it("emits the crash sentinel for a run with no metric", () => {
    const rows: TsvExperimentRow[] = [
      { gitSha: sha, valBpb: null, memoryGb: null, verdict: "crash", description: "OOM during eval" },
    ];
    expect(renderResultsTsv(rows)).toBe(
      `commit\tval_bpb\tmemory_gb\tstatus\tdescription\n3f9a1c2\t0.000000\t0.0\tcrash\tOOM during eval\n`,
    );
  });

  it("preserves commas inside a description", () => {
    const rows: TsvExperimentRow[] = [
      {
        gitSha: sha,
        valBpb: 0.9979,
        memoryGb: 44.0,
        verdict: "keep",
        description: "widen head, drop the ff bias, drop the ff gain",
      },
    ];
    const rendered = renderResultsTsv(rows);
    expect(rendered.split("\n")[1]).toBe(
      "3f9a1c2\t0.997900\t44.0\tkeep\twiden head, drop the ff bias, drop the ff gain",
    );
  });

  it("strips tabs so the column boundary cannot be shifted", () => {
    const rows: TsvExperimentRow[] = [
      {
        gitSha: sha,
        valBpb: 1.004,
        memoryGb: 12.5,
        verdict: "discard",
        description: "init\tsmaller\toutput  projection",
      },
    ];
    const rendered = renderResultsTsv(rows);
    expect(rendered.split("\n")[1]).toBe("3f9a1c2\t1.004000\t12.5\tdiscard\tinitsmalleroutput projection");
    expect(rendered.split("\n")[1]?.split("\t")).toHaveLength(5);
  });

  it("truncates a full sha to seven characters", () => {
    const rows: TsvExperimentRow[] = [
      { gitSha: sha, valBpb: 0.9979, memoryGb: 44.0, verdict: "keep", description: "ok" },
    ];
    expect(renderResultsTsv(rows).split("\n")[1]).toBe("3f9a1c2\t0.997900\t44.0\tkeep\tok");
  });

  it("preserves the caller supplied row order", () => {
    const rows: TsvExperimentRow[] = [
      { gitSha: "aaaaaaaaaaa1", valBpb: 1.1, memoryGb: 10.0, verdict: "discard", description: "first" },
      { gitSha: "bbbbbbbbbbb2", valBpb: 0.9, memoryGb: 11.0, verdict: "keep", description: "second" },
      { gitSha: "ccccccccccc3", valBpb: null, memoryGb: null, verdict: "crash", description: "third" },
    ];
    expect(renderResultsTsv(rows).trimEnd().split("\n").slice(1)).toEqual([
      "aaaaaaa\t1.100000\t10.0\tdiscard\tfirst",
      "bbbbbbb\t0.900000\t11.0\tkeep\tsecond",
      "ccccccc\t0.000000\t0.0\tcrash\tthird",
    ]);
  });

  it("always ends with a trailing newline", () => {
    const rows: TsvExperimentRow[] = [
      { gitSha: sha, valBpb: 0.9979, memoryGb: 44.0, verdict: "keep", description: "ok" },
    ];
    expect(renderResultsTsv(rows).endsWith("\n")).toBe(true);
  });
});

describe("writeResultsTsvAtomic", () => {
  it("replaces the target file with the full regenerated content", () => {
    const directory = mkdtempSync(join(tmpdir(), "studies-tsv-"));
    const filePath = join(directory, "results.tsv");
    try {
      const rows: TsvExperimentRow[] = [
        { gitSha: "3f9a1c2b", valBpb: 0.9979, memoryGb: 44.0, verdict: "keep", description: "ok" },
      ];
      writeResultsTsvAtomic(filePath, renderResultsTsv(rows));
      // A crash between "metrics written" and "row appended" leaves a partial
      // file. Regeneration rewrites the whole thing instead of appending.
      writeResultsTsvAtomic(filePath, renderResultsTsv(rows));
      expect(readFileSync(filePath, "utf8")).toBe(renderResultsTsv(rows));
      expect(readFileSync(filePath, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("EXECUTOR_TRAINING_KWARGS", () => {
  it("keeps the adapter timeout above the kill timeout", () => {
    expect(EXECUTOR_TRAINING_KWARGS.ADAPTER_TIMEOUT_SEC).toBeGreaterThan(
      EXECUTOR_TRAINING_KWARGS.KILL_AFTER_SEC,
    );
  });

  // Gate 0 measured these on an RTX 4060 Ti. They are the reason the bounds are
  // loose: tightening any of them back toward the training budget makes every
  // experiment on a consumer GPU fail or get killed, which is silent and looks
  // like a broken framework rather than a wrong constant.
  const GATE_0 = {
    trainingSeconds: 312.0,
    totalSeconds: 640.0,
    wallClockSeconds: 642.0,
    numSteps: 33,
    peakVramMb: 2985.3,
    mfuPercent: 10.0,
    // Mean of five identical runs at the same commit. The seeds in train.py do
    // not make a run bit-reproducible: cuDNN kernel selection and reduction
    // ordering in backward passes are not deterministic.
    valBpb: 1.007766,
  };

  it("accepts the measured training_seconds overshoot", () => {
    expect(GATE_0.trainingSeconds).toBeLessThanOrEqual(EXECUTOR_TRAINING_KWARGS.MAX_TRAINING_SECONDS);
  });

  it("does not kill a run that legitimately took the measured wall clock", () => {
    expect(GATE_0.wallClockSeconds).toBeLessThan(EXECUTOR_TRAINING_KWARGS.KILL_AFTER_SEC);
  });

  it("clears the kill timeout for the training budget alone", () => {
    expect(EXECUTOR_TRAINING_KWARGS.KILL_AFTER_SEC).toBeGreaterThan(
      EXECUTOR_TRAINING_KWARGS.TIME_BUDGET_SEC,
    );
  });

  it("parses and validates the real Gate 0 baseline run end to end", () => {
    // A genuine consumer-GPU run, transcribed from the Gate 0 log.
    const block = [
      "---",
      "val_bpb:          1.008197",
      "training_seconds: 312.0",
      "total_seconds:    640.0",
      "peak_vram_mb:     2985.3",
      "mfu_percent:      10.00",
      "total_tokens_M:   17.3",
      "num_steps:        33",
      "num_params_M:     50.3",
      "depth:            8",
      "dataset:          tinystories",
      "train_batch_size: 8",
      "eval_batch_size:  8",
      "activation_checkpointing: enabled",
    ].join("\n");

    const parsed = parseAndValidateTrainingSummary(logOf(block), {
      gpuTotalVramBytes: 16380 * 1024 * 1024,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.metrics.valBpb).toBeCloseTo(1.008197, 6);
    expect(parsed.metrics.numSteps).toBe(GATE_0.numSteps);
    expect(parsed.metrics.mfuPercent).toBeCloseTo(GATE_0.mfuPercent, 2);

    // Evaluation cost about as much as training here, so preflight is small and
    // evalSeconds is comparable to training. This is the split that explains why
    // the kill timeout cannot track the training budget: the budget deliberately
    // excludes evaluation, and evaluation is not cheap.
    const timing = deriveTiming(parsed.metrics, GATE_0.wallClockSeconds);
    expect(timing.preflightSeconds).toBeCloseTo(2.0, 0);
    expect(timing.evalSeconds).toBeCloseTo(328.0, 0);
    expect(timing.evalSeconds).toBeGreaterThan(parsed.metrics.trainingSeconds);
  });
});

describe("parseAndValidateTrainingSummary", () => {
  // The shared fixture reports peak_vram_mb 45060.2 (~44 GiB), so the ceiling has
  // to be a card that can actually hold it.
  const GPU_OPTS = { gpuTotalVramBytes: 64 * 1024 * 1024 * 1024 };

  it("accepts a trustworthy run", () => {
    const result = parseAndValidateTrainingSummary(logOf(REAL_BLOCK), GPU_OPTS);
    expect(result.ok).toBe(true);
  });

  it("rejects a plausible-looking block whose token count does not match num_steps", () => {
    // The cheapest anti-forgery signal: train.py computes
    // total_tokens = num_steps * 2**19, so a hand-written block drifts.
    const forged = REAL_BLOCK.replace("total_tokens_M:   499.6", "total_tokens_M:   100.0");
    const result = parseAndValidateTrainingSummary(logOf(forged), GPU_OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("implausible_metrics");
  });

  it("fails closed on a parse error rather than returning the parsed metrics", () => {
    const result = parseAndValidateTrainingSummary("no block here\n", GPU_OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no_summary_block");
  });

  it("does not run the plausibility gate when parsing failed", () => {
    const result = parseAndValidateTrainingSummary(
      logOf(REAL_BLOCK, BLOCK_WITHOUT_TIME_BUDGET_PREFIX),
      GPU_OPTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_time_budget_line");
  });
});