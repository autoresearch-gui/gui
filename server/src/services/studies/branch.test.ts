import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyBranchAction, commitExperimentPatch, runGit, type GitRunner } from "./branch.js";

/**
 * Branch transitions against a real repository.
 *
 * These are the two operations that decide whether a discarded experiment
 * compounds into the next one, and a mocked git cannot catch the failure that
 * matters: a detached HEAD, a hook that blocks, or a patch that does not fit.
 * Each test therefore builds a throwaway repo with `git init`.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo(): Promise<{ dir: string; git: GitRunner; branch: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "autoresearch-branch-"));
  roots.push(dir);
  const git: GitRunner = async (cwd, args) => runGit(cwd, args);

  const init = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });

  init("init", "-b", "main");
  init("config", "user.email", "test@example.com");
  init("config", "user.name", "Test");
  init("config", "commit.gpgsign", "false");

  await writeFile(path.join(dir, "train.py"), "VAL = 1.0\n", "utf8");
  init("add", "-A");
  init("commit", "--no-gpg-sign", "-m", "baseline");

  const branch = "autoresearch/mar5";
  init("checkout", "-b", branch);
  return { dir, git, branch };
}

async function headOf(dir: string): Promise<string> {
  const { stdout } = await runGit(dir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

describe("applyBranchAction", () => {
  it("resets to the target commit on a discard", async () => {
    const repo = await makeRepo();
    const baseline = await headOf(repo.dir);

    await writeFile(path.join(repo.dir, "train.py"), "VAL = 2.0\n", "utf8");
    await repo.git(repo.dir, ["commit", "--no-gpg-sign", "-am", "worse idea"]);
    const discarded = await headOf(repo.dir);
    expect(discarded).not.toBe(baseline);

    const result = await applyBranchAction({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      action: "reset_to_sha",
      targetSha: baseline,
    });

    expect(result.applied).toBe(true);
    expect(result.headAfter).toBe(baseline);
    expect(await readFile(path.join(repo.dir, "train.py"), "utf8")).toContain("VAL = 1.0");
  });

  it("leaves the branch alone for an advance", async () => {
    const repo = await makeRepo();
    const before = await headOf(repo.dir);

    const result = await applyBranchAction({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      action: "advanced",
      experimentSha: before,
    });

    expect(result.applied).toBe(true);
    expect(await headOf(repo.dir)).toBe(before);
  });

  it("leaves the branch alone for a simplification keep, and says so", async () => {
    const repo = await makeRepo();
    const before = await headOf(repo.dir);

    const result = await applyBranchAction({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      action: "adopt_simplification",
      experimentSha: before,
    });

    expect(result.applied).toBe(true);
    // A simplification keep advances the branch to the simpler code while
    // leaving bestValBpb alone, which is handled by not passing updatesBest.
    expect(await headOf(repo.dir)).toBe(before);
    expect(result.detail).toMatch(/simplification/i);
  });

  it("refuses to reset on a detached HEAD", async () => {
    const repo = await makeRepo();
    const baseline = await headOf(repo.dir);
    await repo.git(repo.dir, ["checkout", "--detach", baseline]);

    const result = await applyBranchAction({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      action: "reset_to_sha",
      targetSha: baseline,
    });

    // Resetting here would strand the worktree with no branch, and Paperclip's
    // workspace readiness check rejects a branch mismatch, so the next run would
    // never start. Failing loudly is cheaper than finding that overnight.
    expect(result.applied).toBe(false);
    expect(result.detail).toMatch(/detached HEAD/i);
    expect(result.headAfter).toBe(result.headBefore);
  });

  it("refuses to reset when the worktree is on a different branch", async () => {
    const repo = await makeRepo();
    const baseline = await headOf(repo.dir);
    await repo.git(repo.dir, ["checkout", "-b", "somebody-elses-work"]);

    const result = await applyBranchAction({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      action: "reset_to_sha",
      targetSha: baseline,
    });

    expect(result.applied).toBe(false);
    expect(result.detail).toMatch(/expected autoresearch\/mar5/);
  });

  it("refuses a reset with no recorded target", async () => {
    const repo = await makeRepo();
    const result = await applyBranchAction({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      action: "reset_to_sha",
      targetSha: null,
    });
    expect(result.applied).toBe(false);
    expect(result.detail).toMatch(/needs a target commit/i);
  });
});

describe("commitExperimentPatch", () => {
  const patchThatSetsVal2 = [
    "diff --git a/train.py b/train.py",
    "--- a/train.py",
    "+++ b/train.py",
    "@@ -1 +1 @@",
    "-VAL = 1.0",
    "+VAL = 2.0",
    "",
  ].join("\n");

  it("applies a patch and commits it", async () => {
    const repo = await makeRepo();
    const before = await headOf(repo.dir);

    const result = await commitExperimentPatch({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      patchBody: patchThatSetsVal2,
      description: "widen the model",
    });

    expect(result.applied).toBe(true);
    expect(result.headAfter).not.toBe(before);
    expect(await readFile(path.join(repo.dir, "train.py"), "utf8")).toContain("VAL = 2.0");

    const { stdout } = await repo.git(repo.dir, ["log", "-1", "--pretty=%s"]);
    expect(stdout.trim()).toBe("widen the model");
  });

  it("leaves the tree untouched when the patch does not fit", async () => {
    const repo = await makeRepo();
    const before = await headOf(repo.dir);
    const headBeforeTree = await readFile(path.join(repo.dir, "train.py"), "utf8");

    const result = await commitExperimentPatch({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      patchBody: patchThatSetsVal2.replace("-VAL = 1.0", "-SOMETHING ELSE ENTIRELY = 9.9"),
      description: "patch that cannot apply",
    });

    // The check happens before anything is written, so the next run cannot
    // inherit a half-applied change.
    expect(result.applied).toBe(false);
    expect(result.detail).toMatch(/did not apply cleanly/);
    expect(await headOf(repo.dir)).toBe(before);
    expect(await readFile(path.join(repo.dir, "train.py"), "utf8")).toBe(headBeforeTree);
  });

  it("reports a patch that fails to stage without throwing", async () => {
    const repo = await makeRepo();
    const result = await commitExperimentPatch({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      patchBody: patchThatSetsVal2,
      description: "cannot stage",
      writeTempFile: async () => {
        throw new Error("disk full");
      },
    });
    expect(result.applied).toBe(false);
    expect(result.detail).toMatch(/could not stage the patch/);
  });

  it("cleans up its temp patch file on the failure path too", async () => {
    const repo = await makeRepo();
    const seen: string[] = [];
    await commitExperimentPatch({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      patchBody: patchThatSetsVal2,
      description: "cleanup check",
      writeTempFile: async () => {
        const file = path.join(repo.dir, "temp.patch");
        await writeFile(file, patchThatSetsVal2, "utf8");
        return file;
      },
      removeTempFile: async (file) => {
        seen.push(file);
        await rm(file, { force: true });
      },
    });
    expect(seen).toHaveLength(1);
  });

  it("commits without a signing prompt even when signing is configured", async () => {
    const repo = await makeRepo();
    await repo.git(repo.dir, ["config", "commit.gpgsign", "true"]);
    await repo.git(repo.dir, ["config", "user.signingkey", "does-not-exist"]);

    const result = await commitExperimentPatch({
      git: repo.git,
      worktreePath: repo.dir,
      branchName: repo.branch,
      patchBody: patchThatSetsVal2,
      description: "must not prompt for a signature",
    });

    expect(result.applied).toBe(true);
  });
});