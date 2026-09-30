// The deterministic experiment executor for the autoresearch subsystem.
//
// This process runs one autoresearch training run and decides whether the run
// produced a trustworthy metric. It is the whole of the "framework executes and
// adjudicates" half of the product: the LLM proposes a change to `train.py`,
// this process runs it, and only a run this process accepts is allowed near the
// research ledger.
//
// A crash is detected by the ABSENCE of a metrics file, never by a language
// model reading a stack trace. That is the design constraint that shapes
// everything below. Because this process always writes an output file, even for
// a run that produced no metrics at all, the caller can distinguish "crashed"
// (status "invalid", metrics null) from "ran and won" (status "succeeded")
// with one existence check and no interpretation.
//
// The deterministic core is the plausibility gate. Everything it checks is
// cross-derived: a number that only exists if the run actually executed. The
// strongest of them is `total_tokens_M` versus `num_steps * 2**19`, because
// `train.py` computes that product exactly, so a hand-forged metrics block
// almost always gets one of the two wrong.
//
// Location matters. This file lives in `server/src/services/scripts/` because
// `server/package.json`'s build copies that directory into
// `dist/services/scripts/`, which is what ships in the published package, the
// Docker image, and `npx`. `tsc` does not emit `.mjs`, so any other location
// would exist in a source checkout and be absent from every published artifact.
// It must also never be copied into a study worktree: that would place the
// framework's own parser inside the agent's write scope, where an agent could
// simply edit the judge.
//
// EXIT CODES
//   0  succeeded  - exit code 0, block fully parsed, worktree and CANNOT list
//                   intact, plausibility gate clean. A metrics file was written.
//   1  invalid    - anything else. A metrics file was still written, with
//                   "status": "invalid", an `invalidReason`, and the plausibility
//                   failure list. The caller distinguishes usable from not.
//   2  bad usage  - argv validation failed. Nothing was launched and no metrics
//                   file was written, because there is no run to describe.
//
// Node built-ins only. No dependencies. Every pure step is a named export so it
// can be tested without a GPU, without `uv`, and without a worktree.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Bumped only when a change to this file can change which runs are accepted. */
export const EXECUTOR_VERSION = "1";

/**
 * The exact argv used to launch training.
 *
 * `--frozen --no-sync` is mandatory, not an optimisation. A bare `uv run`
 * implicitly re-resolves and installs, so anything an agent added to
 * `pyproject.toml` would be silently installed at run time, defeating the
 * upstream CANNOT-list rule without anyone noticing. The venv is provisioned
 * once at study creation and pinned via `UV_PROJECT_ENVIRONMENT`; this argv
 * only ever consumes it.
 *
 * `--smoke-test` is deliberately absent and must never be added. Under smoke
 * test the evaluation uses ~1/40th of the tokens, so `val_bpb` is not
 * comparable to any other run. A cheap metric is a poisoned ledger.
 */
export const TRAIN_ARGV = Object.freeze(["run", "--frozen", "--no-sync", "train.py"]);

/**
 * Ground truth pinned from the read-only side of the framework contract.
 * Mirrors `EXECUTOR_TRAINING_KWARGS` in `server/src/services/studies/metrics.ts`.
 */
export const TRAINING_KWARGS = Object.freeze({
  /** `TIME_BUDGET` in `prepare.py`, which the agent may import but not change. */
  TIME_BUDGET_SEC: 300,
  /** `TOTAL_BATCH_SIZE = 2 ** 19` in `train.py`. */
  TOTAL_BATCH_SIZE: 524288,
  MIN_TRAINING_SECONDS: 270,
  MAX_TRAINING_SECONDS: 480,
  MIN_NUM_STEPS: 11,
  VAL_BPB_PLAUSIBLE_MIN: 0.5,
  VAL_BPB_PLAUSIBLE_MAX: 3.0,
  TOKEN_CONSISTENCY_TOLERANCE: 0.01,
});

/**
 * Files hashed before and after every run.
 *
 * `train.py` is the one file the agent is meant to change, so a change to it is
 * informational. The other three are the CANNOT list: `prepare.py` holds
 * `evaluate_bpb` (the metric itself), and `pyproject.toml` / `uv.lock` pin the
 * environment. A change to any of them means the run is not comparable.
 */
export const HASHED_FILES = Object.freeze([
  "train.py",
  "prepare.py",
  "pyproject.toml",
  "uv.lock",
]);

/** The subset of `HASHED_FILES` whose modification invalidates a run. */
export const FORBIDDEN_FILES = Object.freeze(["prepare.py", "pyproject.toml", "uv.lock"]);

/** Relative path of the autotune profile inside the local app data directory. */
export const AUTOTUNE_PROFILE_RELATIVE = Object.freeze([
  "autoresearch",
  "gpu-profile-v2.json",
]);

/**
 * Environment variable names passed through to the training child.
 *
 * This is a security control, not a convenience. The training process is
 * agent-written Python running inside the Paperclip server's process tree, and
 * an inherited environment would hand it the Paperclip API key, the
 * runtime-tools bearer token, and every provider key configured on the host.
 * So the child environment is constructed from scratch against this list. The
 * list is never extended to "delete the bad ones after inheriting", because
 * inherit-then-delete is exactly the pattern that leaks the variable nobody
 * thought of.
 *
 * Matched case-insensitively, because Windows environment names are
 * case-insensitive and `ProgramData` and `PROGRAMDATA` are the same variable.
 * The source key's own spelling is preserved.
 */
export const ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PYTHONUTF8",
  "PYTHONIOENCODING",
  "PYTORCH_ALLOC_CONF",
  "HF_HUB_DISABLE_PROGRESS_BARS",
  "CUDA_PATH",
  "CUDA_HOME",
]);

/**
 * Prefixes passed through wholesale because the framework, not the agent, pins
 * their values. `UV_PROJECT_ENVIRONMENT` (the shared venv) and
 * `AUTORESEARCH_CACHE_DIR` (the dataset cache) are both set by the study
 * service and must reach the child intact or the run reads no data.
 */
export const ENV_ALLOWED_PREFIXES = Object.freeze(["AUTORESEARCH_", "UV_"]);

/**
 * Variables the child environment forces, overriding whatever the source had.
 *
 * `HF_HUB_OFFLINE=1` is the cheapest exfiltration brake available: training
 * needs no network, so anything that tries to reach one fails immediately
 * instead of succeeding quietly.
 */
export const ENV_FORCED = Object.freeze({
  HF_HUB_OFFLINE: "1",
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
});

/**
 * Names whose presence in the child environment is a bug worth recording.
 *
 * `PAPERCLIP_API_KEY` and `PAPERCLIP_RUNTIME_TOOLS_TOKEN` are both matched by
 * the pattern, so they need no special case. Only the NAMES are ever recorded;
 * a value that reached this point would be a live credential, and writing it
 * into a metrics file on disk would turn a leak into a durable one.
 */
export const SECRET_LIKE_PATTERN = /(key|token|secret|password|passwd|authorization|cookie)/i;

/** The summary marker `train.py` prints on its own line before the metrics block. */
const SUMMARY_MARKER = "---";

/** `key: value` with the value taken greedily after the first colon. */
const KEY_VALUE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;

/** `prepare.py` prints this before the block, from its read-only constant. */
const TIME_BUDGET_PATTERN = /^Time budget:\s*(\d+)s/;

/** The literal `train.py` prints when it cannot compute MFU. Not zero. */
const MFU_UNAVAILABLE = "n/a";

/**
 * The block schema is closed. A key outside this set means the block is not the
 * block this executor knows how to judge, so it is rejected rather than skipped.
 */
const KNOWN_BLOCK_KEYS = Object.freeze([
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
]);

/**
 * Every metric that must be present and must parse as a finite number.
 * `mfu_percent` is excluded because it is legitimately nullable.
 */
const REQUIRED_NUMERIC_KEYS = Object.freeze([
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
]);

/**
 * Pre-block labels scraped for provenance, mapped to camelCase keys.
 *
 * `Time budget:` is deliberately absent: it is parsed separately into the
 * NUMBER `provenance.timeBudgetSeconds` and checked against the pinned
 * constant, so scraping the raw `"300s"` string here would put a second,
 * string-typed value at the same key.
 *
 * Longer and more specific labels are matched first. `GPU VRAM:` cannot collide
 * with `GPU:` because the character after `GPU` differs, but ordering the
 * specific ones first keeps that true by construction rather than by luck.
 */
const PROVENANCE_LABELS = Object.freeze([
  ["GPU VRAM:", "gpuVram"],
  ["GPU CC:", "gpuCc"],
  ["GPU profile:", "gpuProfile"],
  ["GPU:", "gpuName"],
  ["Consumer matrix support:", "consumerMatrixSupport"],
  ["TF32:", "tf32"],
  ["AMP dtype:", "ampDtype"],
  ["Vocab size:", "vocabSize"],
  ["Gradient accumulation steps:", "gradientAccumulationSteps"],
  ["Estimated FLOPs per token:", "estimatedFlopsPerToken"],
]);

/** Exit codes, named so the contract is greppable from the server side. */
export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

/** Every flag the executor accepts. Anything else is a usage error. */
const KNOWN_FLAGS = new Set([
  "--worktree",
  "--seq",
  "--out",
  "--log",
  "--kill-after",
  "--gpu-total-mib",
  "--smoke-test",
  "--replay",
]);

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["--smoke-test", "--replay"]);

/**
 * Split a log into lines, tolerating CRLF.
 *
 * `train.py` runs under the Windows toolchain, so the log arrives with CRLF.
 * A naive `split("\n")` leaves a trailing `\r` on every line, which would make
 * an exact `---` comparison fail on every single run.
 */
function splitLines(log) {
  return log.split(/\r\n|\n|\r/);
}

/** A summary marker must be the whole line, with no decoration around it. */
function isSummaryMarker(line) {
  return line.trim() === SUMMARY_MARKER;
}

function roundToTenth(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Parse a strictly-formed positive integer.
 *
 * `Number.parseInt` is deliberately not used: it accepts `"900abc"` and
 * `"12.7"`, so a typo in a flag value would silently become a different number
 * and a kill timeout would be set to something nobody asked for.
 */
function parsePositiveInteger(raw) {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isExistingDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build the child environment from the allowlist.
 *
 * Never inherit-then-delete: the child is constructed key by key from `source`.
 *
 * @param {Record<string, string | undefined>} source Typically `process.env`.
 * @returns {{
 *   env: Record<string, string>,
 *   envKeys: string[],
 *   leakedSecretLikeKeys: string[],
 * }}
 *   `leakedSecretLikeKeys` is expected to be empty. It exists so a regression in
 *   the allowlist shows up in the attestation instead of going unnoticed.
 */
export function buildChildEnv(source) {
  const allow = new Set(ENV_ALLOWLIST.map((name) => name.toUpperCase()));
  const prefixes = ENV_ALLOWED_PREFIXES.map((prefix) => prefix.toUpperCase());
  const env = {};
  const leakedSecretLikeKeys = [];

  for (const [name, value] of Object.entries(source)) {
    if (typeof name !== "string" || typeof value !== "string") continue;
    const upper = name.toUpperCase();
    const allowed = allow.has(upper) || prefixes.some((prefix) => upper.startsWith(prefix));
    if (!allowed) continue;
    // Keep the source key's own spelling; Windows is case-insensitive but a log
    // reader is not.
    env[name] = value;
    if (SECRET_LIKE_PATTERN.test(name)) leakedSecretLikeKeys.push(name);
  }

  for (const [name, value] of Object.entries(ENV_FORCED)) {
    env[name] = value;
    if (SECRET_LIKE_PATTERN.test(name)) leakedSecretLikeKeys.push(name);
  }

  return {
    env,
    envKeys: Object.keys(env).sort((a, b) => a.localeCompare(b)),
    leakedSecretLikeKeys: leakedSecretLikeKeys.sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Validate argv.
 *
 * Fails closed and specifically. A bad `--seq` must not be read as a sequence
 * of zero, and a `--worktree` that does not exist must never reach `spawn`,
 * because `uv run` with a bad cwd produces a confusing error that looks like a
 * framework bug.
 *
 * @param {string[]} argv `process.argv.slice(2)`.
 * @param {{ isDirectory?: (p: string) => boolean }} [deps] Injectable probes.
 * @returns {{ ok: true, options: {
 *   worktree: string, sequence: number, outPath: string, logPath: string,
 *   killAfterSec: number, smokeTest: boolean, replay: boolean,
 *   gpuTotalVramMb: number | null
 * } } | { ok: false, error: string }}
 */
export function parseArgs(argv, deps = {}) {
  const isDirectory = deps.isDirectory ?? isExistingDirectory;

  const values = new Map();
  const flags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) {
      return { ok: false, error: `unexpected positional argument: ${String(token)}` };
    }
    // The flag name is resolved before a value is consumed for it. Checking
    // unknown flags afterwards would report a trailing `--turbo` as
    // "missing value for --turbo", which sends an operator looking for a
    // problem that is not the one they have.
    if (!KNOWN_FLAGS.has(token)) {
      return { ok: false, error: `unknown flag: ${token}` };
    }
    if (BOOLEAN_FLAGS.has(token)) {
      if (flags.has(token)) {
        return { ok: false, error: `repeated flag: ${token}` };
      }
      flags.add(token);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      return { ok: false, error: `missing value for ${token}` };
    }
    if (values.has(token)) {
      return { ok: false, error: `repeated flag: ${token}` };
    }
    values.set(token, next);
    index += 1;
  }

  for (const required of ["--worktree", "--seq", "--out", "--log", "--kill-after"]) {
    const value = values.get(required);
    if (value === undefined || value.trim() === "") {
      return { ok: false, error: `missing required flag: ${required}` };
    }
  }

  const worktree = (values.get("--worktree") ?? "").trim();
  if (!isAbsolute(worktree)) {
    return { ok: false, error: `--worktree must be an absolute path, got: ${worktree}` };
  }
  if (!isDirectory(worktree)) {
    return { ok: false, error: `--worktree is not an existing directory: ${worktree}` };
  }

  const sequence = parsePositiveInteger((values.get("--seq") ?? "").trim());
  if (sequence === null) {
    return {
      ok: false,
      error: `--seq must be a positive integer, got: ${JSON.stringify(values.get("--seq"))}`,
    };
  }

  const killAfterSec = parsePositiveInteger((values.get("--kill-after") ?? "").trim());
  if (killAfterSec === null) {
    return {
      ok: false,
      error: `--kill-after must be a positive integer number of seconds, got: ${JSON.stringify(
        values.get("--kill-after"),
      )}`,
    };
  }

  const smokeTest = flags.has("--smoke-test");
  const replay = flags.has("--replay");
  if (smokeTest && !replay) {
    // A smoke-test metric is never comparable, so it is accepted only in the
    // explicit replay path, where a human is re-deriving a known result and no
    // ledger row will be written from it.
    return {
      ok: false,
      error: "--smoke-test is only permitted together with --replay",
    };
  }

  const gpuRaw = values.get("--gpu-total-mib");
  let gpuTotalVramMb = null;
  if (gpuRaw !== undefined) {
    const trimmed = gpuRaw.trim();
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) {
      return { ok: false, error: `--gpu-total-mib must be a positive number, got: ${gpuRaw}` };
    }
    gpuTotalVramMb = Number.parseFloat(trimmed);
    if (!Number.isFinite(gpuTotalVramMb) || gpuTotalVramMb <= 0) {
      return { ok: false, error: `--gpu-total-mib must be a positive number, got: ${gpuRaw}` };
    }
  }

  return {
    ok: true,
    options: {
      worktree,
      sequence,
      outPath: (values.get("--out") ?? "").trim(),
      logPath: (values.get("--log") ?? "").trim(),
      killAfterSec,
      smokeTest,
      replay,
      gpuTotalVramMb,
    },
  };
}

/**
 * Read the worktree HEAD, or null when git cannot answer.
 *
 * A null is recorded, not fatal. A worktree that is not a git repository at all
 * has no HEAD to protect, and refusing to run there would be a stranger failure
 * than the thing the run is actually for.
 */
export function readWorktreeHead(worktree) {
  try {
    const out = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const head = out.trim();
    return head === "" ? null : head;
  } catch {
    return null;
  }
}

/**
 * sha256 every name in `HASHED_FILES` inside `worktree`.
 * A missing file records as null, which is distinguishable from an empty hash.
 */
export function hashWorktreeFiles(worktree) {
  const hashes = {};
  for (const name of HASHED_FILES) {
    try {
      const bytes = readFileSync(join(worktree, name));
      hashes[name] = createHash("sha256").update(bytes).digest("hex");
    } catch {
      hashes[name] = null;
    }
  }
  return hashes;
}

/**
 * Compare the before and after hashes of the CANNOT list.
 *
 * A `train.py` change is the entire point of the system, so it is reported
 * separately and is never a failure. Anything on the forbidden list means the
 * metric is not comparable to any other run in the study.
 *
 * @returns {{ forbiddenFileModified: string[] }}
 */
export function findModifiedForbiddenFiles(before, after) {
  const modified = [];
  for (const name of FORBIDDEN_FILES) {
    if (before[name] !== after[name]) modified.push(name);
  }
  return { forbiddenFileModified: modified };
}

/**
 * Absolute path of the autotune GPU profile.
 *
 * `prepare.py` prefers `AUTORESEARCH_CACHE_DIR` and then `~/.cache`, but on
 * this machine neither exists and the profile lives under `%LOCALAPPDATA%`.
 * Falls back to a home-relative path so the probe reports something real rather
 * than `undefined/...`.
 */
export function autotuneProfilePath(env, home = homedir(), platform = process.platform) {
  const fromEnv = typeof env.LOCALAPPDATA === "string" ? env.LOCALAPPDATA.trim() : "";
  const base =
    fromEnv !== ""
      ? fromEnv
      : platform === "win32"
        ? join(home, "AppData", "Local")
        : join(home, ".cache");
  return join(base, ...AUTOTUNE_PROFILE_RELATIVE);
}

/**
 * Whether the autotune profile is absent right now.
 *
 * Recorded because a cold baseline pays the autotune cost and is therefore not
 * perfectly comparable to every later warm run. It does not invalidate anything;
 * it just has to be visible next to the number.
 */
export function detectAutotuneCold(env, home = homedir(), platform = process.platform) {
  return !existsSync(autotuneProfilePath(env, home, platform));
}

/**
 * Kill a child and everything it started.
 *
 * Windows: `taskkill /T /F` reaps the whole tree, including grandchildren.
 * Gate 0 measured that `uv` places its child in a Job Object with kill-on-close,
 * so killing `uv` does reap Python here, but relying on another tool's
 * internals is not a guarantee, so `taskkill /T /F` stays the primary.
 *
 * POSIX: the child is spawned `detached` so it leads its own process group and
 * `kill(-pid)` reaches the whole group. Falls back to the direct child.
 *
 * @returns {"taskkill" | "group" | "child" | "no_pid" | "failed"} which strategy ran.
 */
export function killProcessTree(child, platform = process.platform) {
  const pid = child !== null && typeof child === "object" && typeof child.pid === "number" ? child.pid : null;
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return "no_pid";

  if (platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        // taskkill missing or the process already gone: nothing more to do.
      });
      killer.unref();
      return "taskkill";
    } catch {
      return "failed";
    }
  }

  try {
    process.kill(-pid, "SIGKILL");
    return "group";
  } catch {
    try {
      child.kill("SIGKILL");
      return "child";
    } catch {
      return "failed";
    }
  }
}

/**
 * Best-effort scrape of the pre-block environment lines.
 *
 * Total by design: provenance is descriptive only, and a malformed line in an
 * untrusted log must never take down the run that produced the metrics.
 *
 * @param {string[]} lines Lines from before the summary marker.
 * @returns {Record<string, unknown>} May be empty.
 */
export function scrapeProvenance(lines) {
  const provenance = {};
  const autotuneLines = [];
  try {
    for (const raw of lines) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      if (/autotune/i.test(trimmed)) {
        autotuneLines.push(trimmed);
        provenance.autotuneSelected = trimmed;
        continue;
      }
      for (const [label, key] of PROVENANCE_LABELS) {
        if (trimmed.startsWith(label)) {
          provenance[key] = trimmed.slice(label.length).trim();
          break;
        }
      }
    }
    if (autotuneLines.length > 0) provenance.autotuneLines = autotuneLines;
  } catch {
    // Intentionally swallowed. See the contract above.
  }
  return provenance;
}

/**
 * `peak_vram_mb / 1024`, rounded to one decimal.
 *
 * The upstream ledger calls this `memory_gb`. It is really GiB derived from a
 * MiB peak. The name is kept for upstream fidelity, so `results.tsv` matches.
 */
export function deriveMemoryGb(peakVramMb) {
  if (!Number.isFinite(peakVramMb)) return null;
  return roundToTenth(peakVramMb / 1024);
}

/**
 * Parse the delimited metrics block `train.py` prints at the end of `main()`.
 *
 * The block is everything after the single `---` marker to the end of the log.
 * `train.py` prints it last, so a complete block followed by more output means
 * the log is not the log the run ended with and the numbers in it can no longer
 * be trusted as that run's result.
 *
 * @param {string} log Full run log, stdout and stderr interleaved.
 * @returns {{ ok: true, metrics: Record<string, unknown>, timeBudgetSeconds: number | null,
 *   provenance: Record<string, unknown> } | { ok: false, code: string, detail: string }}
 */
export function parseMetricsBlock(log) {
  if (typeof log !== "string") {
    return { ok: false, code: "unreadable_log", detail: "log was not a string" };
  }
  const lines = splitLines(log);

  const markerIndices = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isSummaryMarker(lines[index])) markerIndices.push(index);
  }
  if (markerIndices.length === 0) {
    return {
      ok: false,
      code: "no_summary_block",
      detail: `log contains no "${SUMMARY_MARKER}" summary marker`,
    };
  }
  if (markerIndices.length > 1) {
    // With more than one marker the "last marker" rule would silently prefer a
    // block that is not at the end of the log, which is precisely the
    // substitution an attacker wants. Refuse instead of choosing.
    return {
      ok: false,
      code: "multiple_summary_blocks",
      detail: `log contains ${markerIndices.length} "${SUMMARY_MARKER}" summary markers; exactly one is expected`,
    };
  }

  const markerIndex = markerIndices[0];
  const preBlock = lines.slice(0, markerIndex);
  const tail = lines.slice(markerIndex + 1);

  // `train.py` prints this from `prepare.py`'s read-only constant, so its
  // presence proves the metric's own implementation was not edited. The last
  // occurrence before the block wins, because a re-print supersedes an earlier
  // one and the gate below compares the value to the pinned constant anyway.
  let timeBudgetSeconds = null;
  for (const line of preBlock) {
    const match = TIME_BUDGET_PATTERN.exec(line.trim());
    if (match !== null) timeBudgetSeconds = Number.parseInt(match[1], 10);
  }
  if (timeBudgetSeconds === null) {
    return {
      ok: false,
      code: "missing_time_budget_line",
      detail: `no "Time budget: <n>s" line before the summary block; expected ${TRAINING_KWARGS.TIME_BUDGET_SEC}s`,
    };
  }

  const pairs = new Map();
  const garbage = [];
  for (const line of tail) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = KEY_VALUE_PATTERN.exec(trimmed);
    if (match === null) {
      // Buffer rather than fail immediately. A complete well-formed block
      // followed by this means the block is not at the end of the log; the same
      // line appearing before a metric line means the block is corrupt.
      garbage.push(trimmed);
      continue;
    }
    if (garbage.length > 0) {
      return {
        ok: false,
        code: "unparsable_line",
        detail: `metric line follows unparsable output inside the summary block: ${garbage[0]}`,
      };
    }
    const key = match[1];
    if (!KNOWN_BLOCK_KEYS.includes(key)) {
      return { ok: false, code: "unparsable_line", detail: `unknown key "${key}" inside the summary block` };
    }
    // Alignment is variable, so the value is trimmed rather than sliced at a
    // fixed column.
    pairs.set(key, match[2].trim());
  }

  if (pairs.has("smoke_test")) {
    // Under `--smoke-test` the evaluation uses ~1/40th of the tokens, so the
    // `val_bpb` is not comparable to any other run. A cheap metric for free is
    // a metric that poisons the ledger, so this is refused regardless of value.
    return {
      ok: false,
      code: "smoke_test_run",
      detail: "summary block reports a smoke test; smoke-test val_bpb is not comparable to a full run",
    };
  }

  if (garbage.length > 0) {
    const complete = REQUIRED_NUMERIC_KEYS.every((key) => pairs.has(key));
    if (complete) {
      return {
        ok: false,
        code: "trailing_garbage",
        detail: `summary block is followed by further output: ${garbage[0]}`,
      };
    }
    return {
      ok: false,
      code: "unparsable_line",
      detail: `unparsable line inside the summary block: ${garbage[0]}`,
    };
  }

  const missing = REQUIRED_NUMERIC_KEYS.filter((key) => !pairs.has(key));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing_required_field",
      detail: `summary block is missing required field(s): ${missing.join(", ")}`,
    };
  }

  const numbers = {};
  for (const key of REQUIRED_NUMERIC_KEYS) {
    const raw = pairs.get(key);
    const parsed = Number(raw);
    // `Number("")` is 0 and `Number(" ")` is 0, so an empty value is rejected
    // explicitly before the finite check.
    if (raw === undefined || raw === "" || !Number.isFinite(parsed)) {
      return {
        ok: false,
        code: "unparsable_line",
        detail: `field "${key}" is not a finite number: ${JSON.stringify(raw ?? null)}`,
      };
    }
    numbers[key] = parsed;
  }

  // `n/a` means the executor could not compute MFU: unknown peak FLOPs for this
  // GPU name, or zero steady-state steps. It is NOT zero, and collapsing it to
  // 0 would fabricate a catastrophic efficiency result.
  let mfuPercent = null;
  if (pairs.has("mfu_percent")) {
    const mfuRaw = pairs.get("mfu_percent") ?? "";
    if (mfuRaw.toLowerCase() === MFU_UNAVAILABLE) {
      mfuPercent = null;
    } else {
      const parsed = Number(mfuRaw);
      if (mfuRaw === "" || !Number.isFinite(parsed)) {
        return {
          ok: false,
          code: "unparsable_line",
          detail: `field "mfu_percent" is neither a finite number nor "${MFU_UNAVAILABLE}": ${JSON.stringify(mfuRaw)}`,
        };
      }
      mfuPercent = parsed;
    }
  }

  // Explicit mapping. `Boolean("disabled")` is true, which would credit a run
  // for a memory optimization it never enabled and poison any comparison
  // driven off that flag.
  const checkpointingRaw = pairs.get("activation_checkpointing");
  let activationCheckpointing;
  if (checkpointingRaw === "enabled") {
    activationCheckpointing = true;
  } else if (checkpointingRaw === "disabled") {
    activationCheckpointing = false;
  } else {
    return {
      ok: false,
      code: "unparsable_line",
      detail: `field "activation_checkpointing" must be "enabled" or "disabled", got ${JSON.stringify(
        checkpointingRaw ?? null,
      )}`,
    };
  }

  const peakVramMb = numbers.peak_vram_mb;
  const datasetRaw = pairs.get("dataset");

  return {
    ok: true,
    timeBudgetSeconds,
    metrics: {
      valBpb: numbers.val_bpb,
      trainingSeconds: numbers.training_seconds,
      totalSeconds: numbers.total_seconds,
      peakVramMb,
      mfuPercent,
      totalTokensM: numbers.total_tokens_M,
      numSteps: numbers.num_steps,
      numParamsM: numbers.num_params_M,
      depth: numbers.depth,
      dataset: datasetRaw === undefined || datasetRaw === "" ? null : datasetRaw,
      trainBatchSize: numbers.train_batch_size,
      evalBatchSize: numbers.eval_batch_size,
      activationCheckpointing,
      memoryGb: deriveMemoryGb(peakVramMb),
    },
    provenance: scrapeProvenance(preBlock),
  };
}

/**
 * The plausibility gate.
 *
 * Every failure is collected rather than short-circuited, so an operator reading
 * a rejection sees the whole picture instead of fixing one field at a time.
 * Each bound is chosen to catch a fabricated or truncated run, not to police
 * benign overshoot: a bound that rejects a real run is worse than a loose one.
 *
 * @param {{ metrics: Record<string, unknown>, timeBudgetSeconds: number | null }} parsed
 * @param {{ gpuTotalVramMb?: number | null }} [opts]
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function checkPlausibility(parsed, opts = {}) {
  // A parse failure already decided the run is unusable. Fail the gate cleanly
  // rather than throwing, so a caller that pipelines parse into gate without
  // checking `parsed.ok` gets a verdict it can record instead of a TypeError.
  if (!parsed || typeof parsed !== "object" || !parsed.metrics) {
    return {
      ok: false,
      failures: ["no parsed metrics; the summary block did not parse"],
    };
  }
  const gpuTotalVramMb =
    typeof opts.gpuTotalVramMb === "number" && Number.isFinite(opts.gpuTotalVramMb)
      ? opts.gpuTotalVramMb
      : null;
  const metrics = parsed.metrics;
  const failures = [];
  const num = (key) => {
    const value = metrics[key];
    return typeof value === "number" ? value : Number.NaN;
  };

  // Catches a loop that exited early (crash, OOM, an agent-driven sys.exit) but
  // still reached the print statement, and a `training_seconds` typed in by hand.
  // The lower bound absorbs first-step autograd and kernel-compile cost. The
  // upper bound is loose on purpose: the loop breaks only at a step boundary and
  // a step is ~15s on this card, so the measured baseline overshot the 300s
  // budget to 311.5s, and a real run is allowed to overshoot too. This is a
  // runaway detector, not a deadline.
  const trainingSeconds = num("trainingSeconds");
  if (
    !Number.isFinite(trainingSeconds) ||
    trainingSeconds < TRAINING_KWARGS.MIN_TRAINING_SECONDS ||
    trainingSeconds > TRAINING_KWARGS.MAX_TRAINING_SECONDS
  ) {
    failures.push(
      `training_seconds ${trainingSeconds} is outside [${TRAINING_KWARGS.MIN_TRAINING_SECONDS}, ${TRAINING_KWARGS.MAX_TRAINING_SECONDS}]`,
    );
  }

  // Step count is the slowest-moving plausibility signal. A budgeted run on this
  // card completes tens of steps, and ten or fewer forces `mfu_percent` to
  // `n/a` because the steady-state step count is `max(num_steps - 10, 0)`.
  const numSteps = num("numSteps");
  if (!Number.isFinite(numSteps) || numSteps < TRAINING_KWARGS.MIN_NUM_STEPS) {
    failures.push(`num_steps ${numSteps} is below the minimum ${TRAINING_KWARGS.MIN_NUM_STEPS}`);
  }

  // Catches an untrained model, a wrong tokenizer, or a number copied out of
  // another run's log. Anchored on the measured baseline of 1.024859.
  const valBpb = num("valBpb");
  if (
    !Number.isFinite(valBpb) ||
    valBpb < TRAINING_KWARGS.VAL_BPB_PLAUSIBLE_MIN ||
    valBpb > TRAINING_KWARGS.VAL_BPB_PLAUSIBLE_MAX
  ) {
    failures.push(
      `val_bpb ${valBpb} is outside the plausible range [${TRAINING_KWARGS.VAL_BPB_PLAUSIBLE_MIN}, ${TRAINING_KWARGS.VAL_BPB_PLAUSIBLE_MAX}]`,
    );
  }

  // A run that never touched the GPU reports no memory, which means it was not
  // the run we think it was. The upper bound is only enforced when the caller
  // told us the card size; the 5% absorbs allocator rounding and the gap
  // between reserved and reported capacity.
  const peakVramMb = num("peakVramMb");
  if (!Number.isFinite(peakVramMb) || peakVramMb <= 0) {
    failures.push(`peak_vram_mb ${peakVramMb} must be greater than 0`);
  } else if (gpuTotalVramMb !== null && peakVramMb > gpuTotalVramMb * 1.05) {
    failures.push(
      `peak_vram_mb ${peakVramMb} exceeds the reported GPU capacity of ${roundToTenth(gpuTotalVramMb)} MiB`,
    );
  }

  // The forgery check, and the single most useful one. `train.py` computes
  // total tokens as exactly `num_steps * TOTAL_BATCH_SIZE`, so the two printed
  // numbers are not independent: they are one number printed twice. An agent
  // that hand-writes a metrics block picks a plausible `num_steps` and
  // independently invents a plausible `total_tokens_M`, and the two almost
  // never agree to 1%. Nothing else in the block cross-checks a second field,
  // which is why this catches a hand-assembled block that satisfies every
  // individual range check.
  const totalTokensM = num("totalTokensM");
  const expectedTokensM = (numSteps * TRAINING_KWARGS.TOTAL_BATCH_SIZE) / 1e6;
  if (!Number.isFinite(totalTokensM) || !Number.isFinite(expectedTokensM) || expectedTokensM <= 0) {
    failures.push(
      `cannot check token consistency: total_tokens_M ${totalTokensM} against expected ${expectedTokensM}`,
    );
  } else {
    const relativeError = Math.abs(totalTokensM - expectedTokensM) / expectedTokensM;
    if (relativeError > TRAINING_KWARGS.TOKEN_CONSISTENCY_TOLERANCE) {
      failures.push(
        `total_tokens_M ${totalTokensM} disagrees with num_steps * TOTAL_BATCH_SIZE (${roundToTenth(
          expectedTokensM,
        )} M) by ${(relativeError * 100).toFixed(2)}%, above the ${
          TRAINING_KWARGS.TOKEN_CONSISTENCY_TOLERANCE * 100
        }% tolerance`,
      );
    }
  }

  // Proves `prepare.py`'s read-only `TIME_BUDGET` constant was untouched. An
  // agent that raised the budget bought itself more training and a different
  // operating point, which is not comparable to anything else in the study.
  if (parsed.timeBudgetSeconds !== TRAINING_KWARGS.TIME_BUDGET_SEC) {
    failures.push(
      `time_budget_seconds ${parsed.timeBudgetSeconds} does not equal the pinned ${TRAINING_KWARGS.TIME_BUDGET_SEC}s`,
    );
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Write JSON to `outPath` atomically.
 *
 * The write and the rename happen in the same directory, so the rename cannot
 * degrade into a cross-device copy. A reader therefore sees either no file or a
 * complete one, never a truncated one. That is what lets the caller detect a
 * crash by the absence of the file rather than by parsing it.
 */
export function writeJsonAtomic(outPath, value) {
  const temporaryPath = `${outPath}.tmp`;
  // Create the destination directory here rather than relying on the caller. A
  // missing directory must not be able to discard an eleven-minute GPU run, and
  // this must happen before training starts rather than at write time, so the
  // failure surfaces in seconds instead of after the whole budget is spent.
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, outPath);
}

/**
 * The single stdout line the server captures instead of re-reading the file.
 * Deliberately small: it is a summary, not a second copy of the metrics.
 */
export function summarizeForStdout(payload) {
  const valBpb = payload.metrics !== null && payload.metrics !== undefined ? payload.metrics.valBpb : null;
  return JSON.stringify({
    status: payload.status,
    sequence: payload.sequence,
    exitCode: payload.exitCode,
    killedBy: payload.killedBy,
    invalidReason: payload.invalidReason,
    valBpb: typeof valBpb === "number" ? valBpb : null,
    wallClockSeconds:
      payload.attestation !== null && payload.attestation !== undefined
        ? payload.attestation.wallClockSeconds
        : null,
  });
}

/**
 * Assemble the final payload, applying the usability contract.
 *
 * "Usable" is exit code 0, a fully parsed block, no `invalidReason`, and an
 * empty plausibility failure list. Anything else is still written, marked
 * `invalid`, so the caller can tell the two apart with one read. A metrics
 * object is only ever attached when the whole block parsed; a partial one is
 * never written as if it had succeeded.
 */
export function buildPayload(input) {
  const parsed = input.parsed;
  const metrics = parsed !== null && parsed.ok ? parsed.metrics : null;

  let invalidReason = null;
  if (input.headBefore !== input.headAfter) {
    // Something, most likely the agent, moved the branch under the run. Nothing
    // the run printed can be trusted once the tree it ran against has changed.
    invalidReason = "worktree_head_moved";
  } else if (input.forbiddenFileModified.length > 0) {
    invalidReason = "forbidden_file_modified";
  } else if (input.exitCode !== 0 || input.signal !== null) {
    invalidReason = "nonzero_exit";
  } else if (parsed === null || parsed.ok !== true) {
    invalidReason = "parse_failure";
  } else if (input.plausibilityFailures.length > 0) {
    invalidReason = "implausible_metrics";
  }

  const provenance =
    parsed !== null && parsed.ok ? parsed.provenance : {};
  if (parsed !== null && parsed.ok && parsed.timeBudgetSeconds !== null) {
    provenance.timeBudgetSeconds = parsed.timeBudgetSeconds;
  }

  const status = invalidReason === null && input.plausibilityFailures.length === 0 ? "succeeded" : "invalid";

  return {
    status,
    sequence: input.sequence,
    exitCode: input.exitCode,
    signal: input.signal,
    killedBy: input.killedBy,
    invalidReason,
    plausibilityFailures: input.plausibilityFailures,
    metrics: status === "succeeded" || metrics !== null ? metrics : null,
    provenance,
    attestation: input.attestation,
  };
}

/**
 * Launch the run and wait for it.
 *
 * Owns the kill: a timer armed at spawn for `killAfterSec`, because the training
 * budget deliberately excludes interpreter startup, the autotune pass, and
 * evaluation. The measured baseline is 676.6s wall clock against a 300s
 * training budget, so the upstream 10-minute rule would discard every run on
 * this card; the caller passes 900 and that is per-machine, not a constant.
 *
 * The timer is always cleared in `finally`, so a fast run cannot be held open by
 * a pending kill, and an orphaned `taskkill` cannot fire against a reused pid
 * after this process is gone.
 *
 * @returns {Promise<{ exitCode: number | null, signal: string | null, killedBy: string | null }>}
 */
export function runTraining(options, { env, logPath, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    let logFd;
    try {
      // One descriptor for both stdout and stderr so the two streams interleave
      // in the order the trainer produced them, as `program.md` requires. Two
      // descriptors would produce two files or an arbitrary merge.
      mkdirSync(dirname(logPath), { recursive: true });
      logFd = openSync(logPath, "w");
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        killedBy: null,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let child;
    try {
      child = spawn("uv", [...TRAIN_ARGV], {
        cwd: options.worktree,
        env,
        stdio: ["ignore", logFd, logFd],
        // POSIX only: lead our own process group so a group kill reaches
        // grandchildren. Windows has no process groups; `taskkill /T` covers it.
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      closeSync(logFd);
      resolve({
        exitCode: null,
        signal: null,
        killedBy: null,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let killedBy = null;
    let timer = null;
    const arm = () => {
      timer = setTimeout(() => {
        killedBy = "timeout";
        killProcessTree(child, platform);
      }, options.killAfterSec * 1000);
    };

    // The executor can be killed while the trainer runs. Forward the same tree
    // kill, then leave with 143 so the caller can tell an operator interrupt
    // apart from a crash.
    const onSignal = () => {
      killProcessTree(child, platform);
      process.exit(143);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    let settled = false;
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      closeSync(logFd);
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: null,
        signal: null,
        killedBy,
        spawnError: error instanceof Error ? error.message : String(error),
      });
    });

    // "close" rather than "exit": it fires after the child's stdio is done, so
    // the last log lines are on disk before the log is read.
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: code, signal: signal ?? null, killedBy });
    });

    arm();
  });
}

/**
 * Run one experiment end to end. Resolves with the process exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  const parsedArgs = parseArgs(argv);
  if (parsedArgs.ok !== true) {
    process.stderr.write(`run-experiment: ${parsedArgs.error}\n`);
    return EXIT_USAGE;
  }
  const options = parsedArgs.options;

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  // Pre-run state. Recorded before anything is launched, so a file the run
  // itself rewrites is still detectable.
  const headBefore = readWorktreeHead(options.worktree);
  const hashesBefore = hashWorktreeFiles(options.worktree);

  const { env, envKeys, leakedSecretLikeKeys } = buildChildEnv(process.env);
  const autotuneCold = detectAutotuneCold(process.env);

  const run = await runTraining(options, { env, logPath: options.logPath });

  // Post-run state, taken after the trainer is fully reaped.
  const headAfter = readWorktreeHead(options.worktree);
  const hashesAfter = hashWorktreeFiles(options.worktree);
  const { forbiddenFileModified } = findModifiedForbiddenFiles(hashesBefore, hashesAfter);
  // Bracket access, not dot access: the keys are the file names, so
  // `hashesBefore.train` is a different (absent) property.
  const trainPyChanged = hashesBefore["train.py"] !== hashesAfter["train.py"];

  let log = "";
  try {
    log = readFileSync(options.logPath, "utf8");
  } catch {
    log = "";
  }
  const parsed = parseMetricsBlock(log);
  const plausibility =
    parsed.ok === true ? checkPlausibility(parsed, { gpuTotalVramMb: options.gpuTotalVramMb }) : { ok: false, failures: [] };

  const attestation = {
    executorVersion: EXECUTOR_VERSION,
    argv: [...TRAIN_ARGV],
    worktreePath: options.worktree,
    worktreeHeadBefore: headBefore,
    worktreeHeadAfter: headAfter,
    trainPySha256: hashesAfter["train.py"],
    preparePySha256: hashesAfter["prepare.py"],
    pyprojectSha256: hashesAfter["pyproject.toml"],
    uvLockSha256: hashesAfter["uv.lock"],
    trainPyChanged,
    envKeys,
    leakedSecretLikeKeys,
    autotuneCold,
    startedAt,
    wallClockSeconds: roundToTenth((Date.now() - startedAtMs) / 1000),
  };

  const failures = [...plausibility.failures];
  if (typeof run.spawnError === "string") failures.push(`failed to launch training: ${run.spawnError}`);
  if (forbiddenFileModified.length > 0) {
    failures.push(`CANNOT-list file(s) modified during the run: ${forbiddenFileModified.join(", ")}`);
  }
  if (headBefore !== headAfter) {
    failures.push(`worktree HEAD moved during the run: ${headBefore ?? "unknown"} -> ${headAfter ?? "unknown"}`);
  }

  const payload = buildPayload({
    sequence: options.sequence,
    exitCode: run.exitCode,
    signal: run.signal,
    killedBy: run.killedBy,
    headBefore,
    headAfter,
    forbiddenFileModified,
    plausibilityFailures: failures,
    parsed: parsed.ok === true ? parsed : null,
    attestation,
  });

  try {
    writeJsonAtomic(options.outPath, payload);
  } catch (error) {
    process.stderr.write(
      `run-experiment: failed to write metrics file ${options.outPath}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return EXIT_INVALID;
  }

  if (payload.status === "invalid" && parsed.ok !== true) {
    process.stderr.write(`run-experiment: ${parsed.code}: ${parsed.detail}\n`);
  }

  process.stdout.write(`${summarizeForStdout(payload)}\n`);
  return payload.status === "succeeded" ? EXIT_OK : EXIT_INVALID;
}

// Importing this module must never launch training.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
