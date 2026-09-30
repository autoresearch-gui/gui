import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { studies } from "@paperclipai/db";
import type {
  BaselineSource,
  CreateStudy,
  Study,
  StudySetupCheck,
  StudyStatus,
  UpdateStudy,
} from "@paperclipai/shared";
import { conflict, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import type { StudyActor } from "./experiments.js";
import { studyPaths } from "./paths.js";

/**
 * Study lifecycle and the pre-flight setup gate.
 *
 * A study is one autoresearch run on one `autoresearch/<tag>` branch. Its identity is the
 * branch, so `branch_absent` is the check that matters most at setup: an existing branch
 * means the framework is about to advance history that already has experiments recorded
 * against it.
 */

/** The branch prefix every study owns. Nothing else in the repo may use it. */
export const STUDY_BRANCH_PREFIX = "autoresearch/";

/**
 * The three concrete artifacts a warm autoresearch cache must contain.
 *
 * Probing "directory non-empty" would report a warm cache for a directory holding one
 * unrelated file, and would report missing data for a cache that simply stores its tokenizer
 * somewhere else. These three are the files `prepare.py` actually reads before training, so
 * their presence is the only honest question.
 */
export const CACHE_ARTIFACT_RELATIVE_PATHS = [
  join("datasets", "tinystories", "data", "tinystories_gpt4_clean.parquet"),
  join("datasets", "tinystories", "tokenizer", "tokenizer.pkl"),
  join("datasets", "tinystories", "tokenizer", "token_bytes.pt"),
] as const;

/** Resolved relative to this module so it works from `src/` in dev and `dist/` in a build. */
const EXECUTOR_RELATIVE_PATH = "../scripts/run-experiment.mjs";

export interface CreateStudyInput extends CreateStudy {
  companyId: string;
  actor?: StudyActor;
}

export interface UpdateStudyInput extends UpdateStudy {
  companyId: string;
  studyId: string;
  actor?: StudyActor;
}

export interface StartStudyInput {
  companyId: string;
  studyId: string;
  baselineValBpb?: number | null;
  baselineGitSha?: string | null;
  baselineSource?: BaselineSource | null;
  baselineNote?: string | null;
  noiseFloorBpb?: number | null;
  actor?: StudyActor;
}

export interface PauseStudyInput {
  companyId: string;
  studyId: string;
  reason?: string | null;
  actor?: StudyActor;
}

export interface ConcludeStudyInput {
  companyId: string;
  studyId: string;
  reason?: string | null;
  notes?: string[];
  actor?: StudyActor;
}

const FRAMEWORK_ACTOR: StudyActor = { actorType: "system", actorId: "study_framework" };

export function studyBranchName(tag: string): string {
  return `${STUDY_BRANCH_PREFIX}${tag}`;
}

/** True when the path exists AND is a regular file. A directory with the right name is not it. */
function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function studiesService(db: Db) {
  function loadStudyRow(companyId: string, studyId: string) {
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

  async function create(input: CreateStudyInput) {
    const actor = input.actor ?? FRAMEWORK_ACTOR;
    const paths = studyPaths({ repoPath: input.repoPath, tag: input.tag });
    const created = await db
      .insert(studies)
      .values({
        companyId: input.companyId,
        projectId: input.projectId ?? null,
        name: input.name,
        tag: input.tag,
        // The branch is derived from the tag rather than accepted, because a study and its
        // branch are one thing: two studies on two branch names would double-count one
        // autoresearch run.
        branchName: studyBranchName(input.tag),
        baseRef: input.baseRef,
        repoPath: input.repoPath,
        protocolDocumentId: input.protocolDocumentId ?? null,
        status: input.status ?? "setup",
        venvPath: input.venvPath ?? paths.venvDir,
        cacheDir: input.cacheDir ?? null,
        timeBudgetSec: input.timeBudgetSec ?? 300,
        killAfterSec: input.killAfterSec ?? 900,
        isBaselineRequired: input.isBaselineRequired ?? true,
        baselineValBpb: input.baselineValBpb ?? null,
        baselineGitSha: input.baselineGitSha ?? null,
        baselineSource: input.baselineSource ?? null,
        baselineNote: input.baselineNote ?? null,
        noiseFloorBpb: input.noiseFloorBpb ?? null,
        targetValBpb: input.targetValBpb ?? null,
        keepLastNKeeps: input.keepLastNKeeps ?? 3,
        exploreEveryN: input.exploreEveryN ?? 4,
        minOpenIdeas: input.minOpenIdeas ?? 4,
        maxCrashRetriesPerIdea: input.maxCrashRetriesPerIdea ?? 2,
        maxSimplificationKeepsPerWindow: input.maxSimplificationKeepsPerWindow ?? 1,
        resultsTsvPath: paths.resultsTsv,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!created) throw conflict("Study was not created");

    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "study.created",
      entityType: "study",
      entityId: created.id,
      details: {
        name: created.name,
        tag: created.tag,
        branchName: created.branchName,
        baseRef: created.baseRef,
        repoPath: created.repoPath,
        timeBudgetSec: created.timeBudgetSec,
        killAfterSec: created.killAfterSec,
        exploreEveryN: created.exploreEveryN,
      },
    });
    return created;
  }

  async function update(input: UpdateStudyInput) {
    const actor = input.actor ?? FRAMEWORK_ACTOR;
    const existing = await loadStudyRow(input.companyId, input.studyId);
    const patch: Partial<typeof studies.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.baseRef !== undefined) patch.baseRef = input.baseRef;
    if (input.repoPath !== undefined) patch.repoPath = input.repoPath;
    if (input.projectId !== undefined) patch.projectId = input.projectId;
    if (input.protocolDocumentId !== undefined) patch.protocolDocumentId = input.protocolDocumentId;
    if (input.status !== undefined) patch.status = input.status;
    if (input.venvPath !== undefined) patch.venvPath = input.venvPath;
    if (input.cacheDir !== undefined) patch.cacheDir = input.cacheDir;
    if (input.timeBudgetSec !== undefined) patch.timeBudgetSec = input.timeBudgetSec;
    if (input.killAfterSec !== undefined) patch.killAfterSec = input.killAfterSec;
    if (input.isBaselineRequired !== undefined) patch.isBaselineRequired = input.isBaselineRequired;
    if (input.baselineValBpb !== undefined) patch.baselineValBpb = input.baselineValBpb;
    if (input.baselineGitSha !== undefined) patch.baselineGitSha = input.baselineGitSha;
    if (input.baselineSource !== undefined) patch.baselineSource = input.baselineSource;
    if (input.baselineNote !== undefined) patch.baselineNote = input.baselineNote;
    if (input.noiseFloorBpb !== undefined) patch.noiseFloorBpb = input.noiseFloorBpb;
    if (input.targetValBpb !== undefined) patch.targetValBpb = input.targetValBpb;
    if (input.keepLastNKeeps !== undefined) patch.keepLastNKeeps = input.keepLastNKeeps;
    if (input.exploreEveryN !== undefined) patch.exploreEveryN = input.exploreEveryN;
    if (input.minOpenIdeas !== undefined) patch.minOpenIdeas = input.minOpenIdeas;
    if (input.maxCrashRetriesPerIdea !== undefined) {
      patch.maxCrashRetriesPerIdea = input.maxCrashRetriesPerIdea;
    }
    if (input.maxSimplificationKeepsPerWindow !== undefined) {
      patch.maxSimplificationKeepsPerWindow = input.maxSimplificationKeepsPerWindow;
    }

    // `tag` is deliberately immutable. It names the branch and every derived path, so
    // changing it would orphan the metrics directory, the venv, and the results.tsv the
    // existing experiments already wrote into.
    if (input.tag !== undefined && input.tag !== existing.tag) {
      throw conflict("Study tag cannot be changed after creation", {
        studyId: input.studyId,
        tag: existing.tag,
        requestedTag: input.tag,
      });
    }

    const updated = await db
      .update(studies)
      .set(patch)
      .where(and(eq(studies.companyId, input.companyId), eq(studies.id, input.studyId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("Study not found");

    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "study.updated",
      entityType: "study",
      entityId: updated.id,
      details: { changed: Object.keys(patch).filter((key) => key !== "updatedAt") },
    });
    return updated;
  }

  /**
   * Move a study into `active`.
   *
   * The baseline numbers land here rather than at create time because every later
   * keep/discard verdict is relative to them: a study that required a baseline and started
   * without one would have nothing to compare a first experiment against, and
   * `resolveVerdict` would crown whatever ran first no matter how bad it was.
   */
  async function start(input: StartStudyInput) {
    const actor = input.actor ?? FRAMEWORK_ACTOR;
    const existing = await loadStudyRow(input.companyId, input.studyId);
    if (existing.status === "active") return existing;
    if (existing.status === "concluded") {
      throw conflict("A concluded study cannot be started", { studyId: input.studyId });
    }

    const baselineValBpb = input.baselineValBpb ?? existing.baselineValBpb;
    if (existing.isBaselineRequired && baselineValBpb === null) {
      throw conflict("Study requires a baseline val_bpb before it can start", {
        studyId: input.studyId,
      });
    }

    const timestamp = new Date();
    const updated = await db
      .update(studies)
      .set({
        status: "active",
        baselineValBpb,
        baselineGitSha: input.baselineGitSha ?? existing.baselineGitSha,
        baselineSource: input.baselineSource ?? existing.baselineSource,
        baselineNote: input.baselineNote ?? existing.baselineNote,
        // The noise floor is the band inside which a change is neither a win nor a loss.
        // Seeding it from the operator is what stops the framework advancing on noise.
        noiseFloorBpb: input.noiseFloorBpb ?? existing.noiseFloorBpb,
        // The first successful run after start becomes the incumbent. Using the baseline as
        // the initial best means a hypothesis is measured against the recorded baseline
        // rather than against nothing.
        bestValBpb: existing.bestValBpb ?? baselineValBpb,
        startedAt: existing.startedAt ?? timestamp,
        lastActivityAt: timestamp,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(studies.companyId, input.companyId),
          eq(studies.id, input.studyId),
          sql`${studies.status} in ('setup', 'paused')`,
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw conflict("Study is not in a startable state", { status: existing.status });

    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "study.started",
      entityType: "study",
      entityId: updated.id,
      details: {
        baselineValBpb: updated.baselineValBpb,
        baselineGitSha: updated.baselineGitSha,
        baselineSource: updated.baselineSource,
        noiseFloorBpb: updated.noiseFloorBpb,
        bestValBpb: updated.bestValBpb,
      },
    });
    return updated;
  }

  async function pause(input: PauseStudyInput) {
    const actor = input.actor ?? FRAMEWORK_ACTOR;
    const existing = await loadStudyRow(input.companyId, input.studyId);
    if (existing.status === "paused") return existing;
    if (existing.status === "concluded") {
      throw conflict("A concluded study cannot be paused", { studyId: input.studyId });
    }
    const timestamp = new Date();
    const updated = await db
      .update(studies)
      .set({ status: "paused", lastActivityAt: timestamp, updatedAt: timestamp })
      .where(
        and(
          eq(studies.companyId, input.companyId),
          eq(studies.id, input.studyId),
          sql`${studies.status} in ('setup', 'active')`,
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw conflict("Study is not in a pausable state", { status: existing.status });

    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "study.paused",
      entityType: "study",
      entityId: updated.id,
      details: { reason: input.reason ?? null, fromStatus: existing.status },
    });
    return updated;
  }

  async function conclude(input: ConcludeStudyInput) {
    const actor = input.actor ?? FRAMEWORK_ACTOR;
    const existing = await loadStudyRow(input.companyId, input.studyId);
    if (existing.status === "concluded") return existing;
    const timestamp = new Date();
    const updated = await db
      .update(studies)
      .set({ status: "concluded", concludedAt: timestamp, lastActivityAt: timestamp, updatedAt: timestamp })
      .where(
        and(
          eq(studies.companyId, input.companyId),
          eq(studies.id, input.studyId),
          sql`${studies.status} <> 'concluded'`,
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("Study not found");

    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "study.concluded",
      entityType: "study",
      entityId: updated.id,
      details: {
        reason: input.reason ?? null,
        notes: input.notes ?? [],
        bestValBpb: updated.bestValBpb,
        baselineValBpb: updated.baselineValBpb,
        experimentCount: updated.experimentCount,
        fromStatus: existing.status,
      },
    });
    return updated;
  }

  /**
   * Pre-flight gate for `autoresearch/<tag>`.
   *
   * Each check names one thing that, if wrong, silently produces a study that runs for
   * hours and measures nothing. They are reported rather than thrown on, so an operator can
   * see the whole picture in one place instead of fixing one failure per attempt.
   */
  async function assertSetupComplete(companyId: string, studyId: string): Promise<StudySetupCheck[]> {
    const study = await loadStudyRow(companyId, studyId);
    const paths = studyPaths({ repoPath: study.repoPath, tag: study.tag });
    const checks: StudySetupCheck[] = [];

    checks.push(uvOnPathCheck());
    checks.push(cacheArtifactsCheck(study.cacheDir));
    checks.push(venvResolvesCheck(study.venvPath ?? paths.venvDir));
    checks.push(branchAbsentCheck(study.repoPath, study.branchName));
    checks.push(resultsTsvCheck(study.resultsTsvPath ?? paths.resultsTsv, paths.root));
    checks.push(executorPresentCheck());

    return checks;
  }

  return {
    getById: (companyId: string, studyId: string) => loadStudyRow(companyId, studyId),

    list: (companyId: string, options: { status?: StudyStatus; projectId?: string } = {}) => {
      const conditions = [eq(studies.companyId, companyId)];
      if (options.status) conditions.push(eq(studies.status, options.status));
      if (options.projectId) conditions.push(eq(studies.projectId, options.projectId));
      return db
        .select()
        .from(studies)
        .where(and(...conditions))
        .orderBy(asc(studies.createdAt));
    },

    create,
    update,
    start,
    pause,
    conclude,
    assertSetupComplete,

    /** Studies that still have a live `running` experiment, so the pulse can skip them. */
    listActive: (companyId: string) =>
      db
        .select()
        .from(studies)
        .where(and(eq(studies.companyId, companyId), eq(studies.status, "active")))
        .orderBy(asc(studies.createdAt)),

    /** Open studies with a baseline on record, which is what the morning report iterates. */
    listConcludable: (companyId: string) =>
      db
        .select()
        .from(studies)
        .where(
          and(
            eq(studies.companyId, companyId),
            eq(studies.status, "active"),
            isNotNull(studies.baselineValBpb),
          ),
        )
        .orderBy(asc(studies.createdAt)),

    /** Convenience for callers that only need the shared `Study` shape. */
    get: async (companyId: string, studyId: string): Promise<Study | null> => {
      const row = await loadStudyRow(companyId, studyId);
      return row as unknown as Study;
    },
  };
}

export type StudiesService = ReturnType<typeof studiesService>;

function uvOnPathCheck(): StudySetupCheck {
  try {
    const version = execFileSync("uv", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    return {
      key: "uv_on_path",
      label: "uv is on PATH",
      ok: true,
      detail: version,
    };
  } catch (error) {
    return {
      key: "uv_on_path",
      label: "uv is on PATH",
      ok: false,
      // The executor runs through `uv run --frozen --no-sync`, so a missing uv is a launch
      // failure on every single experiment rather than one setup error.
      detail: `uv is not runnable from this process: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * THE CACHE-PATH TRAP.
 *
 * `prepare.py:_default_cache_dir()` prefers `AUTORESEARCH_CACHE_DIR`, then
 * `~/.cache/autoresearch`, and only on Windows falls back to `%LOCALAPPDATA%\autoresearch`.
 * On the target machine `~/.cache/autoresearch` does not exist and the data lives under
 * LOCALAPPDATA, so probing the POSIX path would report missing data that is already present
 * and send an operator to warm a cache that is already warm. That is why the framework pins
 * `AUTORESEARCH_CACHE_DIR` and probes the pinned path for the three concrete artifacts
 * instead of guessing.
 */
function cacheArtifactsCheck(cacheDir: string | null): StudySetupCheck {
  if (!cacheDir) {
    return {
      key: "cache_artifacts",
      label: "autoresearch cache artifacts are present",
      ok: false,
      detail:
        "no pinned AUTORESEARCH_CACHE_DIR is recorded for this study; without it the executor " +
        "resolves a platform-dependent default and the setup check would probe the wrong path",
    };
  }
  const missing = CACHE_ARTIFACT_RELATIVE_PATHS.filter((relative) => !isFile(join(cacheDir, relative)));
  if (missing.length === 0) {
    return {
      key: "cache_artifacts",
      label: "autoresearch cache artifacts are present",
      ok: true,
      detail: `${CACHE_ARTIFACT_RELATIVE_PATHS.length} of ${CACHE_ARTIFACT_RELATIVE_PATHS.length} artifacts present under ${cacheDir}`,
    };
  }
  return {
    key: "cache_artifacts",
    label: "autoresearch cache artifacts are present",
    ok: false,
    detail: `${missing.length} of ${CACHE_ARTIFACT_RELATIVE_PATHS.length} artifacts missing under ${cacheDir}: ${missing.join(", ")}`,
  };
}

/**
 * The venv has to resolve to a real interpreter before the first experiment.
 *
 * A fresh worktree has no `.venv`, and a bare `uv run` would re-resolve and install, which
 * both costs ~20s per run and would silently install whatever the agent added to
 * `pyproject.toml`. `UV_PROJECT_ENVIRONMENT` points at one shared venv outside the worktrees
 * for exactly that reason, so this check fails if that venv was never provisioned.
 */
function venvResolvesCheck(venvPath: string): StudySetupCheck {
  const candidates =
    process.platform === "win32"
      ? [join(venvPath, "Scripts", "python.exe"), join(venvPath, "bin", "python")]
      : [join(venvPath, "bin", "python"), join(venvPath, "Scripts", "python.exe")];
  const resolved = candidates.find((candidate) => isFile(candidate));
  if (resolved) {
    return { key: "venv_resolves", label: "shared venv resolves", ok: true, detail: resolved };
  }
  return {
    key: "venv_resolves",
    label: "shared venv resolves",
    ok: false,
    detail: `no interpreter under ${venvPath}; run UV_PROJECT_ENVIRONMENT=${venvPath} uv sync --frozen once`,
  };
}

/**
 * The branch must not already exist.
 *
 * A study advances its branch in place, one keep at a time. If the branch is already there,
 * the framework is about to append experiments to a history that already has results in it
 * and reset commits that other experiments point at. Refusing at setup is the only place
 * where that is cheap to detect.
 */
function branchAbsentCheck(repoPath: string, branchName: string): StudySetupCheck {
  try {
    execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    return {
      key: "branch_absent",
      label: `${branchName} does not exist yet`,
      ok: false,
      detail: `branch ${branchName} already exists in ${repoPath}; a study advances one branch in place and cannot share it`,
    };
  } catch (error) {
    const err = error as { code?: string; stdout?: unknown; stderr?: unknown };
    // git exits non-zero when the ref does not resolve. A missing repository or a missing git
    // binary fails the same way, so the stderr is what distinguishes them.
    const stderrRaw = err.stderr;
    const stderr =
      typeof stderrRaw === "string"
        ? stderrRaw.trim()
        : Buffer.isBuffer(stderrRaw)
          ? stderrRaw.toString("utf8").trim()
          : "";
    if (/not a git repository|Unable to read|Could not read/i.test(stderr)) {
      return {
        key: "branch_absent",
        label: `${branchName} does not exist yet`,
        ok: false,
        detail: `git could not read ${repoPath}: ${stderr || "not a git repository"}`,
      };
    }
    return {
      key: "branch_absent",
      label: `${branchName} does not exist yet`,
      ok: true,
      detail: `${branchName} is absent from ${repoPath}`,
    };
  }
}

/**
 * The ledger's directory has to exist and be writable before the first settle.
 *
 * `results.tsv` itself is written atomically at every settle, so the check is about the
 * parent directory: a study whose `.autoresearch/<tag>` was never provisioned would fail at
 * the end of a twelve-minute run instead of at setup.
 */
function resultsTsvCheck(resultsTsvPath: string, studyRoot: string): StudySetupCheck {
  const parent = dirname(resultsTsvPath);
  if (existsSync(parent)) {
    return { key: "results_tsv", label: "results.tsv directory is provisioned", ok: true, detail: parent };
  }
  if (existsSync(studyRoot)) {
    return {
      key: "results_tsv",
      label: "results.tsv directory is provisioned",
      ok: true,
      detail: `${studyRoot} exists; results.tsv is written to ${resultsTsvPath} on first settle`,
    };
  }
  return {
    key: "results_tsv",
    label: "results.tsv directory is provisioned",
    ok: false,
    detail: `${studyRoot} does not exist yet; the study data directory has to be created before the first run`,
  };
}

function executorPresentCheck(): StudySetupCheck {
  const executorPath = fileURLToPath(new URL(EXECUTOR_RELATIVE_PATH, import.meta.url));
  if (isFile(executorPath)) {
    return { key: "executor_present", label: "experiment executor is present", ok: true, detail: executorPath };
  }
  logger.warn({ executorPath }, "study executor script was not found");
  return {
    key: "executor_present",
    label: "experiment executor is present",
    ok: false,
    detail: `executor script ${executorPath} is missing; every experiment would fail to launch`,
  };
}
