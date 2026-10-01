import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git operations the framework performs on a study branch.
 *
 * These are deliberately narrow. The framework owns exactly two branch
 * transitions, both of which `program.md` already specifies, and it must not be
 * able to do anything else - in particular it must never merge to master or
 * force-push. Everything an agent might want to do to the branch beyond these
 * two transitions is the agent's business, not the framework's.
 *
 * `applyPatch` deliberately uses `git apply --check` before applying, so a patch
 * that does not fit is refused before the branch moves.
 */
export type BranchAction = "advanced" | "reset_to_sha" | "adopt_simplification";

export interface GitRunner {
  (cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export const runGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      // Never let git open an interactive pager or prompt for credentials: this
      // runs unattended overnight, and a prompt would hang the study silently.
      env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [`git ${args.join(" ")}`, err.stderr, err.stdout, err.message]
        .filter(Boolean)
        .join("\n")
        .trim(),
    );
  }
};

export interface BranchApplyResult {
  applied: boolean;
  headBefore: string | null;
  headAfter: string | null;
  detail: string;
}

export interface EnsureBranchResult {
  created: boolean;
  head: string | null;
  detail: string;
}

/**
 * Creates the study branch if it does not exist yet.
 *
 * Needed because of a genuine tension between two existing contracts. Study setup
 * asserts the branch is *absent*, so an operator is never silently adopting a
 * branch with history on it. But the dispatch issue pins that branch with
 * `existingBranch`, and exact-branch realization fails closed if the branch does
 * not already exist - it never creates one, because renaming or creating would
 * defeat the point of pinning an exact branch.
 *
 * So the framework creates the branch itself, at dispatch time, from `baseRef`.
 * That keeps both invariants: a study still never adopts pre-existing history,
 * and the pinned workspace can still attach. Idempotent, because several
 * experiments can race for the same first branch.
 *
 * Never called with a branch that setup already vouched for, and never moves an
 * existing branch: if it is already there, this is a no-op.
 */
export async function ensureStudyBranch(
  git: GitRunner,
  input: { repoPath: string; branchName: string; baseRef: string },
): Promise<EnsureBranchResult> {
  const exists = await git(input.repoPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${input.branchName}`,
  ])
    .then(() => true)
    .catch(() => false);

  if (exists) {
    // The branch's own head, not the repository's HEAD: the operator's checkout
    // is on some other branch, and reporting that would look like the study
    // branch had been reset.
    const head = await git(input.repoPath, ["rev-parse", `refs/heads/${input.branchName}`])
      .then((r) => r.stdout.trim() || null)
      .catch(() => null);
    return {
      created: false,
      head,
      detail: `${input.branchName} already exists`,
    };
  }

  // `branch <name> <baseRef>` creates the branch without checking it out, which
  // matters: the repo is the operator's own checkout and must stay on whatever
  // they left it on.
  await git(input.repoPath, ["branch", input.branchName, input.baseRef]);
  const head = await git(input.repoPath, ["rev-parse", `refs/heads/${input.branchName}`])
    .then((r) => r.stdout.trim() || null)
    .catch(() => null);

  return {
    created: true,
    head,
    detail: `created ${input.branchName} at ${input.baseRef}`,
  };
}

async function currentHead(git: GitRunner, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await git(cwd, ["rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Applies a verdict's git action to the study worktree.
 *
 * `advanced` and `adopt_simplification` are no-ops: the worktree is already at
 * the experiment's commit, because that is where the run happened. Only
 * `reset_to_sha` moves anything, and that is the point of the whole mechanism -
 * it is what stops a discarded experiment from compounding into the next one.
 *
 * Refuses to run on a detached HEAD. `git reset --hard` on a detached HEAD would
 * leave the worktree with no branch, and Paperclip's workspace readiness check
 * rejects a branch mismatch, so the next run would fail to start. Restoring the
 * branch is cheaper than discovering that overnight.
 */
export async function applyBranchAction(input: {
  git: GitRunner;
  worktreePath: string;
  branchName: string;
  action: BranchAction;
  /** Commit to reset to, required for `reset_to_sha`. */
  targetSha?: string | null;
  /** Commit the experiment ran at, for the no-op actions. */
  experimentSha?: string | null;
}): Promise<BranchApplyResult> {
  const { git, worktreePath, branchName, action } = input;
  const headBefore = await currentHead(git, worktreePath);

  if (action === "reset_to_sha") {
    if (!input.targetSha) {
      return {
        applied: false,
        headBefore,
        headAfter: headBefore,
        detail: "reset_to_sha needs a target commit, and none was recorded",
      };
    }

    // A detached HEAD here would strand the worktree, so fail loudly instead.
    let branch: string;
    try {
      const { stdout } = await git(worktreePath, ["symbolic-ref", "--short", "HEAD"]);
      branch = stdout.trim();
    } catch {
      return {
        applied: false,
        headBefore,
        headAfter: headBefore,
        detail: "the worktree is on a detached HEAD; refusing to reset",
      };
    }
    if (branch !== branchName) {
      return {
        applied: false,
        headBefore,
        headAfter: headBefore,
        detail: `the worktree is on ${branch}, expected ${branchName}; refusing to reset`,
      };
    }

    await git(worktreePath, ["reset", "--hard", input.targetSha]);
    const headAfter = await currentHead(git, worktreePath);
    return {
      applied: true,
      headBefore,
      headAfter,
      detail: `reset ${branchName} to ${input.targetSha.slice(0, 7)}`,
    };
  }

  // advanced and adopt_simplification both leave the branch where the run left it.
  // adopt_simplification deliberately does NOT touch the best commit; that is
  // handled by not passing updatesBest to the study row.
  const detail =
    action === "advanced"
      ? `kept ${headBefore?.slice(0, 7) ?? "unknown"} on ${branchName}`
      : `adopted the simplification at ${headBefore?.slice(0, 7) ?? "unknown"} on ${branchName}`;
  return { applied: true, headBefore, headAfter: headBefore, detail };
}

/**
 * Materializes an experiment's patch and commits it.
 *
 * Called before the executor runs, so the run happens on a committed tree and the
 * commit hash in the record is the code that actually produced the metric. The
 * `apply --check` first means a patch that does not fit is refused while the
 * branch is still clean, instead of leaving a half-applied change for the next
 * run to inherit.
 */
export async function commitExperimentPatch(input: {
  git: GitRunner;
  worktreePath: string;
  branchName: string;
  patchBody: string;
  description: string;
  /** Injected so tests do not touch the real filesystem. */
  writeTempFile?: (contents: string) => Promise<string>;
  removeTempFile?: (filePath: string) => Promise<void>;
}): Promise<BranchApplyResult> {
  const { git, worktreePath, patchBody } = input;
  const headBefore = await currentHead(git, worktreePath);

  const writeTempFile =
    input.writeTempFile ??
    (async (contents: string) => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), "autoresearch-patch-")), "experiment.patch");
      writeFileSync(file, contents, "utf8");
      return file;
    });
  const removeTempFile =
    input.removeTempFile ??
    (async (file: string) => {
      rmSync(file, { force: true });
    });

  // The patch goes through a temp file rather than stdin. A file keeps the git
  // child from blocking on an unread pipe, which would hang the study silently
  // overnight, and it makes the exact bytes that were applied inspectable.
  let patchFile: string;
  try {
    patchFile = await writeTempFile(patchBody);
  } catch (error) {
    return {
      applied: false,
      headBefore,
      headAfter: headBefore,
      detail: `could not stage the patch: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const fits = await git(worktreePath, ["apply", "--check", "--whitespace=nowarn", patchFile]).then(
      () => true,
      () => false,
    );
    if (!fits) {
      return {
        applied: false,
        headBefore,
        headAfter: headBefore,
        detail: "the patch did not apply cleanly; the branch was left untouched",
      };
    }

    await git(worktreePath, ["apply", "--whitespace=nowarn", patchFile]);
    await git(worktreePath, ["add", "-A"]);
    // --no-verify and --no-gpg-sign, and a supplied message: a hook, a signing
    // prompt, or an editor here would block a run that must never block.
    await git(worktreePath, [
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      input.description,
    ]);

    const headAfter = await currentHead(git, worktreePath);
    return {
      applied: true,
      headBefore,
      headAfter,
      detail: `committed ${headAfter?.slice(0, 7) ?? "unknown"}`,
    };
  } finally {
    await removeTempFile(patchFile).catch(() => {
      /* the temp file lives under the OS temp root, so a leak is reclaimable */
    });
  }
}