import path from "node:path";

/**
 * Filesystem layout for one study.
 *
 * Everything a study measures lives BESIDE the repo, under `<repoPath>/.autoresearch/<tag>`,
 * and never inside the worktree. Two independent reasons:
 *
 * 1. Worktrees get cleaned. `git worktree remove` and the workspace reaper delete the
 *    directory the study was pointed at, so metrics, logs, and the venv would vanish with
 *    it and the study could never be resumed on the same branch.
 * 2. The branch gets rewound. Every discard verdict is a `git reset`, and a reset cannot
 *    be trusted not to take untracked-but-unignored files with it in every git version
 *    and every platform. Study state has to survive a rewind of the thing it is measuring.
 *
 * The venv lives here rather than in the worktree for the same reason plus one more: a
 * fresh worktree has no `.venv`, and bare `uv run` would re-resolve and install, which
 * both costs ~20s per run and would silently install whatever an agent added to
 * `pyproject.toml`. `UV_PROJECT_ENVIRONMENT` points here so `uv sync --frozen` runs once
 * and every later run is `uv run --frozen --no-sync`.
 */
export interface StudyPaths {
  /** `<repoPath>/.autoresearch/<tag>` */
  root: string;
  /** What the executor writes to: one `<sequence>.json` per run. */
  metricsDir: string;
  /** The executor's redirected stdout+stderr, one `<sequence>.log` per run. */
  logDir: string;
  /** The single shared venv, referenced through `UV_PROJECT_ENVIRONMENT`. */
  venvDir: string;
  /** The derived export. Regenerated atomically; never appended. */
  resultsTsv: string;
  /**
   * GPU exclusivity lock. The database partial unique index arbitrates WHICH experiment
   * may start; this file stops a leaked trainer that is still holding the card.
   */
  gpuLockFile: string;
  /** Framework-owned gitignore, wired in through `core.excludesFile`. */
  excludesFile: string;
}

export const STUDY_DATA_DIR_NAME = ".autoresearch";

export function studyPaths(study: { repoPath: string; tag: string }): StudyPaths {
  const root = path.join(study.repoPath, STUDY_DATA_DIR_NAME, study.tag);
  return {
    root,
    metricsDir: path.join(root, "metrics"),
    logDir: path.join(root, "logs"),
    venvDir: path.join(root, "venv"),
    resultsTsv: path.join(root, "results.tsv"),
    gpuLockFile: path.join(root, "gpu.lock"),
    excludesFile: path.join(root, "excludes"),
  };
}

export function studyMetricsFile(study: { repoPath: string; tag: string }, sequence: number): string {
  return path.join(studyPaths(study).metricsDir, `${sequence}.json`);
}

export function studyLogFile(study: { repoPath: string; tag: string }, sequence: number): string {
  return path.join(studyPaths(study).logDir, `${sequence}.log`);
}

/**
 * Contents of the framework-owned excludes file.
 *
 * WHY a framework-owned excludes file instead of editing the repo's `.gitignore`:
 * the agent is the thing being supervised, and it can rewrite `.gitignore`. An agent that
 * appends its own paths to the tracked `.gitignore` (or deletes an existing rule) changes
 * what `git status` shows, which is exactly the surface the framework relies on to notice
 * `run.log`, a stale checkpoint, or a stray tmp file left behind by a run. `results.tsv`
 * is deliberately NOT excluded: upstream does not ignore it, it is meant to be committed,
 * and committing it makes tampering visible as a diff.
 *
 * `.autoresearch/` is excluded so the metrics, logs, and venv never appear as untracked
 * noise in the study worktree's `git status`.
 */
export const EXCLUDES_FILE_CONTENT = [
  "# Managed by Paperclip's autoresearch study service. Do not edit.",
  "# Rewriting the tracked .gitignore would let the supervised agent hide evidence",
  "# from the framework, so these rules live in a file the framework owns and wires",
  "# in through git's core.excludesFile.",
  "",
  "run.log",
  "checkpoint_pre_eval.pt",
  "*.tmp",
  ".autoresearch/",
  "",
].join("\n");
