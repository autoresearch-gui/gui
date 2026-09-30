import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";

import { experiments, studies } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { notFound } from "../../errors.js";
import { studyPaths } from "./paths.js";

const execFileAsync = promisify(execFile);

/**
 * Replay verification: the only answer to "can a fabricated `val_bpb` survive?".
 *
 * The executor's plausibility gate catches a forged block cheaply - `train.py`
 * computes `total_tokens = num_steps * 2**19` exactly, so a hand-written block
 * drifts - but that is a filter, not proof. This re-runs an experiment from its
 * recorded commit and diffs the observed metric against the recorded one.
 * `train.py` fixes its seeds, so a legitimate replay lands within the study's
 * measured noise floor. A large delta is either real nondeterminism, which
 * becomes measurable, or a lie, which becomes visible.
 *
 * The alternative - trusting the log - answers the question only for the case
 * where nobody tried to cheat.
 */
export type ReplayDisposition =
  /** Observed metric matched the record within the noise floor. */
  | "reproduced"
  /** Observed metric diverged beyond the noise floor. Treat the record as suspect. */
  | "diverged"
  /** The run could not be replayed: missing commit, executor failure, no metric. */
  | "inconclusive";

export interface ReplayResult {
  disposition: ReplayDisposition;
  experimentId: string;
  studyId: string;
  sequence: number;
  gitSha: string | null;
  recordedValBpb: number | null;
  observedValBpb: number | null;
  delta: number | null;
  /** Comparison tolerance, taken from the study's measured baseline noise floor. */
  tolerance: number;
  noiseFloorBpb: number | null;
  reason: string;
  observedMetrics: Record<string, unknown> | null;
}

export interface VerifyDeps {
  /** Runs git in `cwd`. Injected so tests never need a real repository. */
  git: (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Runs the executor. Injected so tests never invoke training. */
  runExecutor: (args: {
    worktree: string;
    outPath: string;
    logPath: string;
    killAfterSec: number;
  }) => Promise<{ exitCode: number | null }>;
  /** Absolute path to the shipped executor. */
  executorPath: string;
  now?: () => Date;
}

const DEFAULT_NOISE_FLOOR = 0.02;

/**
 * Replays one experiment and compares the observed `val_bpb` with the record.
 *
 * Does not mutate the experiment. A divergence is a finding for a human to act
 * on, not something to silently rewrite, because the two likely causes - a lying
 * record and genuine nondeterminism - need opposite responses.
 */
export async function verifyExperiment(
  db: Db,
  input: { companyId: string; experimentId: string },
  deps: VerifyDeps,
): Promise<ReplayResult> {
  const row = await db
    .select({ experiment: experiments, study: studies })
    .from(experiments)
    .innerJoin(studies, eq(studies.id, experiments.studyId))
    .where(and(eq(experiments.companyId, input.companyId), eq(experiments.id, input.experimentId)))
    .then((rows) => rows[0] ?? null);
  if (!row) {
    throw notFound("Experiment not found");
  }
  const { experiment, study } = row;

  const base: Omit<ReplayResult, "disposition" | "reason"> = {
    experimentId: experiment.id,
    studyId: study.id,
    sequence: experiment.sequence,
    gitSha: experiment.gitSha,
    recordedValBpb: experiment.valBpb,
    observedValBpb: null,
    delta: null,
    tolerance: DEFAULT_NOISE_FLOOR,
    noiseFloorBpb: study.noiseFloorBpb,
    observedMetrics: null,
  };

  // Without a measured noise floor there is nothing to compare against, so fall
  // back to a small constant and say so rather than pretending to a precision
  // the study never established.
  if (study.noiseFloorBpb === null) {
    base.tolerance = DEFAULT_NOISE_FLOOR;
  } else {
    base.tolerance = Math.max(study.noiseFloorBpb, 0.0001);
  }

  if (experiment.verdict === "crash" || experiment.valBpb === null) {
    return {
      ...base,
      disposition: "inconclusive",
      reason: "The experiment produced no metric, so there is nothing to replay against.",
    };
  }
  if (!experiment.gitSha) {
    return {
      ...base,
      disposition: "inconclusive",
      reason: "The experiment recorded no commit, so there is nothing to check out.",
    };
  }

  const paths = studyPaths(study);
  const scratchRoot = await mkdtemp(path.join(tmpdir(), "autoresearch-verify-"));
  const worktree = path.join(scratchRoot, "worktree");
  const outPath = path.join(scratchRoot, "metrics.json");
  const logPath = path.join(scratchRoot, "replay.log");

  try {
    // `--detach` so a replay can never move the study's branch. The executor
    // refuses a run whose worktree HEAD moved during the run, and a replay that
    // could move the branch would corrupt the very record it is checking.
    await deps.git(paths.root, ["worktree", "add", "--detach", worktree, experiment.gitSha]);
  } catch (error) {
    await rm(scratchRoot, { recursive: true, force: true });
    return {
      ...base,
      disposition: "inconclusive",
      reason: `Could not check out ${experiment.gitSha.slice(0, 7)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  try {
    const run = await deps.runExecutor({
      worktree,
      outPath,
      logPath,
      // A replay gets the same kill budget the original run had, or a slow
      // machine would make every honest run look like a divergence.
      killAfterSec: study.killAfterSec,
    });

    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(await readFile(outPath, "utf8")) as Record<string, unknown>;
    } catch {
      payload = null;
    }

    if (run.exitCode !== 0 || !payload || payload.status !== "succeeded") {
      const detail =
        (payload?.invalidReason as string | undefined) ??
        (payload?.plausibilityFailures as string[] | undefined)?.join("; ") ??
        `executor exit ${run.exitCode ?? "null"}`;
      return {
        ...base,
        disposition: "inconclusive",
        reason: `The replay did not produce a usable metric: ${detail}. See ${logPath}.`,
      };
    }

    const observedMetrics = (payload.metrics ?? null) as Record<string, unknown> | null;
    const observedValBpb =
      typeof observedMetrics?.valBpb === "number" ? observedMetrics.valBpb : null;
    if (observedValBpb === null) {
      return {
        ...base,
        disposition: "inconclusive",
        reason: "The replay produced a metrics file with no val_bpb.",
      };
    }

    const delta = observedValBpb - experiment.valBpb;
    // The tolerance is inclusive, but `observed - recorded` in float64 lands a
    // hair above the tolerance for a delta that is exactly equal to it. Scale the
    // comparison by a relative epsilon so an exact-boundary replay is not
    // reported as a divergence.
    const withinTolerance = Math.abs(delta) <= base.tolerance * (1 + 1e-9);
    logger.info(
      {
        studyId: study.id,
        experimentId: experiment.id,
        sequence: experiment.sequence,
        recorded: experiment.valBpb,
        observed: observedValBpb,
        delta,
        tolerance: base.tolerance,
      },
      "study experiment replayed",
    );

    return {
      ...base,
      disposition: withinTolerance ? "reproduced" : "diverged",
      observedValBpb,
      delta,
      observedMetrics,
      reason: withinTolerance
        ? `Replayed ${experiment.gitSha.slice(0, 7)}: val_bpb ${observedValBpb.toFixed(6)} against a recorded ${experiment.valBpb.toFixed(6)}, delta ${delta.toFixed(6)} within the ${base.tolerance} noise floor.`
        : `Replayed ${experiment.gitSha.slice(0, 7)}: val_bpb ${observedValBpb.toFixed(6)} against a recorded ${experiment.valBpb.toFixed(6)}. Delta ${delta.toFixed(6)} exceeds the ${base.tolerance} noise floor, so the record is suspect.`,
    };
  } finally {
    // Best effort: a failed prune must not mask a result, and the scratch dir is
    // under the OS temp root so it is reclaimable either way.
    try {
      await deps.git(paths.root, ["worktree", "remove", "--force", worktree]);
    } catch (error) {
      logger.warn({ err: error, worktree }, "failed to remove the replay scratch worktree");
    }
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

/** Default git runner. Rejects on a non-zero exit so a failed checkout is caught. */
export const runGit: VerifyDeps["git"] = async (cwd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error([err.stderr, err.stdout, err.message].filter(Boolean).join("\n").trim());
  }
};

/**
 * Default executor runner.
 *
 * Spawns the shipped script with `process.execPath` and never through a shell:
 * the script is a `.mjs` asset that the server build copies into `dist`, not a
 * compiled module, so it is passed as a path rather than imported. Node is
 * invoked directly because `uv` on Windows is a batch shim that `CreateProcess`
 * cannot execute.
 */
export function makeExecutorRunner(executorPath: string): VerifyDeps["runExecutor"] {
  return async ({ worktree, outPath, logPath, killAfterSec }) => {
    try {
      await execFileAsync(
        process.execPath,
        [
          executorPath,
          "--worktree",
          worktree,
          "--seq",
          "0",
          "--out",
          outPath,
          "--log",
          logPath,
          "--kill-after",
          String(killAfterSec),
          "--replay",
        ],
        { cwd: worktree, maxBuffer: 8 * 1024 * 1024 },
      );
      return { exitCode: 0 };
    } catch (error) {
      // The executor writes a metrics file even on failure, so surface its exit
      // code rather than throwing: an invalid replay is a disposition, not an
      // exception the caller has to distinguish from a real failure.
      const err = error as { code?: number | string; stderr?: string; stdout?: string };
      const exitCode = typeof err.code === "number" ? err.code : null;
      return { exitCode: exitCode ?? 1 };
    }
  };
}
