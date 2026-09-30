// Tests for the deterministic experiment executor.
//
// No real training happens here and none is needed: every step that decides
// whether a run is acceptable is a pure function, and a pure function can be
// handed a log and a metrics object directly. The expensive part of this
// subsystem is the 11-minute GPU run, and testing it through that would buy
// nothing a log fixture does not already prove.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildChildEnv,
  checkPlausibility,
  deriveMemoryGb,
  findModifiedForbiddenFiles,
  parseArgs,
  parseMetricsBlock,
  summarizeForStdout,
  writeJsonAtomic,
} from "./run-experiment.mjs";

/** Real temp dir per test, removed in `finally`, per the repo's script-test pattern. */
function fixture() {
  return mkdtempSync(join(tmpdir(), "run-experiment-"));
}

/** Baseline run measured on the target RTX 4060 Ti during Gate 0. */
const BASELINE = {
  val_bpb: "1.024859",
  training_seconds: "311.5",
  total_seconds: "672.0",
  peak_vram_mb: "2985.3",
  mfu_percent: "10.01",
  total_tokens_M: "16.8",
  num_steps: "32",
  num_params_M: "50.3",
  depth: "8",
  dataset: "tinystories",
  train_batch_size: "8",
  eval_batch_size: "8",
  activation_checkpointing: "enabled",
};

/**
 * Render a run log. The pre-block lines are the real executor preamble, so the
 * parser is exercised against the shape it will actually meet.
 */
function makeLog({ pairs = {}, pre = {}, order = null, trailing = "", timeBudget = 300 } = {}) {
  const preamble = [
    "GPU: NVIDIA GeForce RTX 4060 Ti",
    "GPU VRAM: 16380 MiB",
    "GPU CC: 8.9",
    "GPU profile: consumer-matrix-ada",
    "Consumer matrix support: yes",
    "TF32: enabled",
    "AMP dtype: bfloat16",
    "Vocab size: 50257",
    "Gradient accumulation steps: 65536",
    "Estimated FLOPs per token: 1.2e9",
    "autotune: selected train_batch_size=8, activation_checkpointing=True",
    ...Object.entries(pre).map(([key, value]) => `${key}: ${value}`),
    `Time budget: ${timeBudget}s`,
  ];
  const merged = { ...BASELINE, ...pairs };
  const keys = order ?? Object.keys(merged);
  return [
    ...preamble,
    "---",
    ...keys.map((key) => `${key}: ${merged[key]}`),
    trailing,
    "",
  ].join("\n");
}

/** A metrics object equivalent to the Gate 0 baseline, for gate-only tests. */
function baselineMetrics() {
  const parsed = parseMetricsBlock(makeLog());
  assert.equal(parsed.ok, true);
  return { metrics: parsed.metrics, timeBudgetSeconds: parsed.timeBudgetSeconds };
}

function validArgs(worktree, extra = []) {
  return [
    "--worktree",
    worktree,
    "--seq",
    "12",
    "--out",
    join(worktree, "metrics.json"),
    "--log",
    join(worktree, "run.log"),
    "--kill-after",
    "900",
    ...extra,
  ];
}

// The gate is the last thing that stands between a truncated or forged block and
// a row in the research ledger, so it must fail closed rather than throw. A
// caller that pipelines parse into gate without checking `parsed.ok` used to get
// a TypeError, which is a crash instead of a recorded verdict.
test("gate: fails closed instead of throwing when the block did not parse", () => {
  const rejected = parseMetricsBlock("nothing to see here\n");
  assert.equal(rejected.ok, false);

  const fromRejected = checkPlausibility(rejected, { gpuTotalVramMb: 16380 });
  assert.equal(fromRejected.ok, false);
  assert.match(fromRejected.failures.join(" "), /did not parse/);
});

test("gate: fails closed on a null or malformed parse result", () => {
  for (const input of [null, undefined, {}, { metrics: null }, "nope"]) {
    const result = checkPlausibility(input, { gpuTotalVramMb: 16380 });
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
    assert.equal(result.failures.length, 1);
  }
});

test("gate: a smoke-test log is rejected rather than parsed into a cheap metric", () => {
  // Under --smoke-test the evaluation uses ~1/40th of the tokens, so its val_bpb
  // is not comparable to a real run. Cheap metric, poisoned ledger.
  const smokeLog = [
    "Time budget: 300s",
    "---",
    "val_bpb:          1.883240",
    "training_seconds: 0.0",
    "total_seconds:    57.5",
    "peak_vram_mb:     2985.3",
    "mfu_percent:      n/a",
    "total_tokens_M:   1.6",
    "num_steps:        3",
    "num_params_M:     50.3",
    "depth:            8",
    "dataset:          tinystories",
    "train_batch_size: 8",
    "eval_batch_size:  8",
    "activation_checkpointing: enabled",
    "smoke_test:       true",
    "",
  ].join("\n");

  const parsed = parseMetricsBlock(smokeLog);
  assert.equal(parsed.ok, false, "a smoke_test log must not parse as a real run");

  const result = checkPlausibility(parsed, { gpuTotalVramMb: 16380 });
  assert.equal(result.ok, false);
});

test("argv: accepts a complete invocation", () => {
  const root = fixture();
  try {
    const parsed = parseArgs(validArgs(root));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.options.worktree, root);
    assert.equal(parsed.options.sequence, 12);
    assert.equal(parsed.options.killAfterSec, 900);
    assert.equal(parsed.options.smokeTest, false);
    assert.equal(parsed.options.replay, false);
    assert.equal(parsed.options.gpuTotalVramMb, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argv: rejects a missing required flag", () => {
  const root = fixture();
  try {
    const argv = validArgs(root).filter((_, index, all) => !(all[index - 1] === "--out"));
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--out/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argv: rejects an empty value for a required flag", () => {
  const root = fixture();
  try {
    const parsed = parseArgs([...validArgs(root).slice(0, 6), "", ...validArgs(root).slice(7)]);
    assert.equal(parsed.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argv: rejects a non-integer --seq", () => {
  const root = fixture();
  try {
    for (const bad of ["twelve", "12.7", "0", "-1", "12abc"]) {
      const argv = validArgs(root);
      argv[argv.indexOf("--seq") + 1] = bad;
      const parsed = parseArgs(argv);
      assert.equal(parsed.ok, false, `--seq ${bad} should be rejected`);
      assert.match(parsed.error, /--seq/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argv: rejects a non-integer --kill-after", () => {
  const root = fixture();
  try {
    const argv = validArgs(root);
    argv[argv.indexOf("--kill-after") + 1] = "15m";
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--kill-after/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argv: rejects a worktree that is not an existing directory", () => {
  const root = fixture();
  try {
    const missing = join(root, "no-such-worktree");
    const parsed = parseArgs(validArgs(missing));
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /not an existing directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argv: rejects a relative worktree", () => {
  const parsed = parseArgs(validArgs("relative/path"));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /absolute/);
});

test("argv: rejects an unknown flag", () => {
  const root = fixture();
  try {
    const parsed = parseArgs([...validArgs(root), "--turbo"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /unknown flag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argv: rejects --smoke-test without --replay", () => {
  const root = fixture();
  try {
    const parsed = parseArgs([...validArgs(root), "--smoke-test"]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--replay/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argv: accepts --smoke-test with --replay and records the GPU size", () => {
  const root = fixture();
  try {
    const parsed = parseArgs([...validArgs(root), "--smoke-test", "--replay", "--gpu-total-mib", "16380"]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.options.smokeTest, true);
    assert.equal(parsed.options.replay, true);
    assert.equal(parsed.options.gpuTotalVramMb, 16380);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("block: parses a clean real baseline block", () => {
  const parsed = parseMetricsBlock(makeLog());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.metrics, {
    valBpb: 1.024859,
    trainingSeconds: 311.5,
    totalSeconds: 672,
    peakVramMb: 2985.3,
    mfuPercent: 10.01,
    totalTokensM: 16.8,
    numSteps: 32,
    numParamsM: 50.3,
    depth: 8,
    dataset: "tinystories",
    trainBatchSize: 8,
    evalBatchSize: 8,
    activationCheckpointing: true,
    memoryGb: 2.9,
  });
  assert.equal(parsed.timeBudgetSeconds, 300);
  assert.equal(parsed.provenance.gpuName, "NVIDIA GeForce RTX 4060 Ti");
  assert.equal(parsed.provenance.gpuVram, "16380 MiB");
  assert.equal(parsed.provenance.consumerMatrixSupport, "yes");
  assert.equal(parsed.provenance.gradientAccumulationSteps, "65536");
  assert.match(parsed.provenance.autotuneSelected, /train_batch_size=8/);
});

test("block: mfu_percent n/a becomes null, not zero", () => {
  const parsed = parseMetricsBlock(makeLog({ pairs: { mfu_percent: "n/a" } }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.metrics.mfuPercent, null);
});

test("block: activation_checkpointing disabled is false (the Boolean(\"disabled\") trap)", () => {
  const parsed = parseMetricsBlock(makeLog({ pairs: { activation_checkpointing: "disabled" } }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.metrics.activationCheckpointing, false);
  // The trap, stated explicitly so the intent survives a future "simplification".
  assert.notEqual(Boolean("disabled"), parsed.metrics.activationCheckpointing);
});

test("block: alignment width does not change the value", () => {
  const log = [
    "Time budget: 300s",
    "---",
    "val_bpb:1.024859",
    "training_seconds:311.5",
    "total_seconds:672.0",
    "peak_vram_mb:2985.3",
    "total_tokens_M:16.8",
    "num_steps:32",
    "num_params_M:50.3",
    "depth:8",
    "train_batch_size:8",
    "eval_batch_size:8",
    "activation_checkpointing:enabled",
    "",
  ].join("\n");
  const parsed = parseMetricsBlock(log);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.metrics.valBpb, 1.024859);
  assert.equal(parsed.metrics.activationCheckpointing, true);
});

test("block: trailing garbage after a complete block is a failure", () => {
  const parsed = parseMetricsBlock(makeLog({ trailing: "Traceback (most recent call last):" }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "trailing_garbage");
});

test("block: two summary markers are a failure", () => {
  const log = `${makeLog()}\n---\nval_bpb: 0.9\n`;
  const parsed = parseMetricsBlock(log);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "multiple_summary_blocks");
});

test("block: a non-numeric value is a failure", () => {
  const parsed = parseMetricsBlock(makeLog({ pairs: { val_bpb: "not-a-number" } }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "unparsable_line");
  assert.match(parsed.detail, /val_bpb/);
});

test("block: an empty numeric value is a failure, not zero", () => {
  const log = makeLog({ pairs: { num_steps: "" } });
  const parsed = parseMetricsBlock(log);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "unparsable_line");
});

test("block: a missing required field is a failure", () => {
  const log = makeLog({ order: Object.keys(BASELINE).filter((key) => key !== "depth") });
  const parsed = parseMetricsBlock(log);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "missing_required_field");
  assert.match(parsed.detail, /depth/);
});

test("block: a missing summary marker is a failure", () => {
  const parsed = parseMetricsBlock("GPU: something\nTime budget: 300s\n");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "no_summary_block");
});

test("block: a missing Time budget line is a failure", () => {
  const log = makeLog().split("\n").filter((line) => !line.startsWith("Time budget:")).join("\n");
  const parsed = parseMetricsBlock(log);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "missing_time_budget_line");
});

test("block: the time budget is captured as a number, not scraped as a string", () => {
  const parsed = parseMetricsBlock(makeLog({ timeBudget: 300 }));
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.timeBudgetSeconds, "number");
  assert.equal(parsed.timeBudgetSeconds, 300);
  // The raw "300s" line is not a provenance field; the parsed number is.
  assert.equal("timeBudgetSeconds" in parsed.provenance, false);
});

test("block: a smoke_test line is refused", () => {
  const log = makeLog({ pairs: { smoke_test: "true" } });
  const parsed = parseMetricsBlock(log);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "smoke_test_run");
});

test("block: an unknown key in the block is a failure", () => {
  const log = makeLog({ pairs: { learning_rate: "0.001" } });
  const parsed = parseMetricsBlock(log);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "unparsable_line");
});

test("gate: the Gate 0 baseline passes", () => {
  const result = checkPlausibility(baselineMetrics());
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

test("gate: a forged total_tokens_M fails the internal-consistency check", () => {
  const parsed = parseMetricsBlock(makeLog({ pairs: { total_tokens_M: "99.9" } }));
  const result = checkPlausibility(parsed);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /total_tokens_M 99.9 disagrees with num_steps/);
});

test("gate: training_seconds of 12 fails", () => {
  const parsed = parseMetricsBlock(makeLog({ pairs: { training_seconds: "12" } }));
  const result = checkPlausibility(parsed);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => /training_seconds 12/.test(failure)));
});

test("gate: num_steps of 4 fails", () => {
  const parsed = parseMetricsBlock(makeLog({ pairs: { num_steps: "4", total_tokens_M: "2.1" } }));
  const result = checkPlausibility(parsed);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => /num_steps 4 is below/.test(failure)));
});

test("gate: val_bpb of 9.9 fails", () => {
  const parsed = parseMetricsBlock(makeLog({ pairs: { val_bpb: "9.9" } }));
  const result = checkPlausibility(parsed);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => /val_bpb 9.9 is outside/.test(failure)));
});

test("gate: a time budget of 600 fails", () => {
  const parsed = parseMetricsBlock(makeLog({ timeBudget: 600 }));
  const result = checkPlausibility(parsed);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /time_budget_seconds 600/);
});

test("gate: collects every failure instead of short-circuiting", () => {
  // Four independent triggers: too-fast training, too few steps (with a
  // token count consistent with those steps, so the consistency check stays
  // silent), an absurd val_bpb, and a rewritten time budget.
  const parsed = parseMetricsBlock(
    makeLog({ pairs: { training_seconds: "5", num_steps: "4", total_tokens_M: "2.1", val_bpb: "99.0" }, timeBudget: 600 }),
  );
  const result = checkPlausibility(parsed);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 4);
  assert.ok(result.failures.some((failure) => /training_seconds/.test(failure)));
  assert.ok(result.failures.some((failure) => /num_steps/.test(failure)));
  assert.ok(result.failures.some((failure) => /val_bpb/.test(failure)));
  assert.ok(result.failures.some((failure) => /time_budget_seconds/.test(failure)));
});

test("gate: peak_vram_mb above the reported card size fails", () => {
  const parsed = parseMetricsBlock(makeLog({ pairs: { peak_vram_mb: "20000" } }));
  assert.equal(checkPlausibility(parsed, { gpuTotalVramMb: 16380 }).ok, false);
  assert.equal(checkPlausibility(parsed, { gpuTotalVramMb: null }).ok, true);
});

test("gate: peak_vram_mb of 0 fails", () => {
  const parsed = parseMetricsBlock(makeLog({ pairs: { peak_vram_mb: "0" } }));
  assert.equal(checkPlausibility(parsed).ok, false);
});

test("env: only allowlisted keys survive, and the rest is dropped", () => {
  const source = {
    PATH: "C:\\Windows",
    LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    PAPERCLIP_API_KEY: "pc-secret",
    OPENAI_API_KEY: "sk-openai-secret",
    TEMP: "C:\\Temp",
    HF_TOKEN: "hf-secret",
  };
  const { env, envKeys, leakedSecretLikeKeys } = buildChildEnv(source);

  assert.deepEqual(envKeys, ["HF_HUB_OFFLINE", "LOCALAPPDATA", "PATH", "PYTHONIOENCODING", "PYTHONUTF8", "TEMP"]);
  assert.deepEqual(Object.keys(env).sort(), envKeys);
  for (const key of ["ANTHROPIC_API_KEY", "PAPERCLIP_API_KEY", "OPENAI_API_KEY", "HF_TOKEN"]) {
    assert.equal(key in env, false, `${key} must not reach the training process`);
  }
  assert.equal(env.PATH, "C:\\Windows");
  assert.equal(env.LOCALAPPDATA, "C:\\Users\\dev\\AppData\\Local");
});

test("env: the offline and utf8 brakes are forced in", () => {
  const { env } = buildChildEnv({ PATH: "x", PYTHONUTF8: "0", PYTHONIOENCODING: "latin-1" });
  assert.equal(env.HF_HUB_OFFLINE, "1");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
});

test("env: no secret-looking value survives, and none is named as leaked", () => {
  const source = {
    PATH: "C:\\Windows",
    LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    PAPERCLIP_API_KEY: "pc-secret",
    PAPERCLIP_RUNTIME_TOOLS_TOKEN: "rt-secret",
    OPENAI_API_KEY: "sk-openai-secret",
    TEMP: "C:\\Temp",
    HF_TOKEN: "hf-secret",
    DB_PASSWORD: "hunter2",
  };
  const { env, leakedSecretLikeKeys } = buildChildEnv(source);
  assert.deepEqual(leakedSecretLikeKeys, []);
  const secretLike = /(key|token|secret|password|passwd|authorization|cookie)/i;
  for (const value of Object.values(env)) {
    assert.equal(secretLike.test(value), false, `secret-like substring survived: ${value}`);
  }
});

test("env: framework-pinned prefixes pass through", () => {
  const { env } = buildChildEnv({
    PATH: "x",
    UV_PROJECT_ENVIRONMENT: "C:\\study\\venv",
    AUTORESEARCH_CACHE_DIR: "C:\\study\\cache",
    UV_INDEX_URL: "https://example.invalid",
  });
  assert.equal(env.UV_PROJECT_ENVIRONMENT, "C:\\study\\venv");
  assert.equal(env.AUTORESEARCH_CACHE_DIR, "C:\\study\\cache");
  assert.equal(env.UV_INDEX_URL, "https://example.invalid");
});

test("env: matching is case-insensitive, as Windows env names are", () => {
  const { env } = buildChildEnv({ Path: "C:\\Windows", localappdata: "C:\\L", ProgramData: "C:\\P" });
  assert.equal(env.Path, "C:\\Windows");
  assert.equal(env.localappdata, "C:\\L");
  assert.equal(env.ProgramData, "C:\\P");
});

test("attestation: the CANNOT list is compared and train.py is not", () => {
  const before = { "train.py": "a", "prepare.py": "b", "pyproject.toml": "c", "uv.lock": "d" };
  const after = { "train.py": "a-changed", "prepare.py": "b", "pyproject.toml": "c", "uv.lock": "d" };
  assert.deepEqual(findModifiedForbiddenFiles(before, after), { forbiddenFileModified: [] });

  const afterUv = { ...before, "train.py": "z", "uv.lock": "d-changed" };
  assert.deepEqual(findModifiedForbiddenFiles(before, afterUv), { forbiddenFileModified: ["uv.lock"] });
});

test("memoryGb divides MiB by 1024 and rounds to one decimal", () => {
  assert.equal(deriveMemoryGb(2985.3), 2.9);
  assert.equal(deriveMemoryGb(0), 0);
  assert.equal(deriveMemoryGb(Number.NaN), null);
});

test("atomic write: the file reads back and leaves no .tmp residue", () => {
  const root = fixture();
  try {
    const out = join(root, "metrics.json");
    writeJsonAtomic(out, { status: "succeeded", sequence: 12, metrics: { valBpb: 1.024859 } });
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(parsed.status, "succeeded");
    assert.equal(parsed.sequence, 12);
    assert.equal(parsed.metrics.valBpb, 1.024859);
    assert.equal(existsSync(`${out}.tmp`), false);
    assert.deepEqual(readdirSync(root), ["metrics.json"]);

    // An overwrite must also be clean: the target is replaced, never appended to.
    writeJsonAtomic(out, { status: "invalid", sequence: 13, metrics: null });
    assert.equal(JSON.parse(readFileSync(out, "utf8")).status, "invalid");
    assert.deepEqual(readdirSync(root), ["metrics.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic write: a prior target is replaced, not truncated in place", () => {
  const root = fixture();
  try {
    const out = join(root, "metrics.json");
    writeFileSync(out, "x".repeat(4096));
    writeJsonAtomic(out, { status: "invalid" });
    // Pretty-printed on purpose: these files get read by a human during an
    // incident, not only by the server.
    assert.equal(readFileSync(out, "utf8"), `${JSON.stringify({ status: "invalid" }, null, 2)}\n`);
    assert.deepEqual(readdirSync(root), ["metrics.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdout summary is one line of JSON carrying valBpb without the file", () => {
  const line = summarizeForStdout({
    status: "succeeded",
    sequence: 12,
    exitCode: 0,
    killedBy: null,
    invalidReason: null,
    metrics: { valBpb: 1.024859 },
    attestation: { wallClockSeconds: 676.6 },
  });
  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line);
  assert.equal(parsed.status, "succeeded");
  assert.equal(parsed.valBpb, 1.024859);
  assert.equal(parsed.wallClockSeconds, 676.6);

  const failed = JSON.parse(
    summarizeForStdout({
      status: "invalid",
      sequence: 13,
      exitCode: 1,
      killedBy: "timeout",
      invalidReason: "parse_failure",
      metrics: null,
      attestation: { wallClockSeconds: 900 },
    }),
  );
  assert.equal(failed.valBpb, null);
  assert.equal(failed.killedBy, "timeout");
});
