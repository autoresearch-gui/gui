import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import { EXCLUDES_FILE_CONTENT, studyLogFile, studyMetricsFile, studyPaths } from "./paths.js";

const STUDY = { repoPath: ["C:", "repos", "autoresearch-win-rtx"].join(sep), tag: "gpt-4070" };

describe("studyPaths", () => {
  it("puts study data beside the repo rather than inside the worktree", () => {
    const paths = studyPaths(STUDY);
    expect(paths.root).toBe([STUDY.repoPath, ".autoresearch", "gpt-4070"].join(sep));
    // Nothing lives under a worktree: a worktree is cleaned and the branch is rewound on
    // every discard, and study data has to survive both.
    expect(paths.root.startsWith(`${STUDY.repoPath}${sep}.git`)).toBe(false);
  });

  it("derives the metrics, log, venv, ledger, lock, and excludes paths", () => {
    const paths = studyPaths(STUDY);
    const root = [STUDY.repoPath, ".autoresearch", "gpt-4070"].join(sep);
    expect(paths.metricsDir).toBe([root, "metrics"].join(sep));
    expect(paths.logDir).toBe([root, "logs"].join(sep));
    expect(paths.venvDir).toBe([root, "venv"].join(sep));
    expect(paths.resultsTsv).toBe([root, "results.tsv"].join(sep));
    expect(paths.gpuLockFile).toBe([root, "gpu.lock"].join(sep));
    expect(paths.excludesFile).toBe([root, "excludes"].join(sep));
  });

  it("separates two studies on different tags of the same repository", () => {
    const a = studyPaths({ repoPath: STUDY.repoPath, tag: "run-a" });
    const b = studyPaths({ repoPath: STUDY.repoPath, tag: "run-b" });
    expect(a.root).not.toBe(b.root);
    expect(a.venvDir).not.toBe(b.venvDir);
  });

  it("addresses executor files by sequence so a run's log and metrics never collide", () => {
    expect(studyMetricsFile(STUDY, 7)).toBe(
      [STUDY.repoPath, ".autoresearch", "gpt-4070", "metrics", "7.json"].join(sep),
    );
    expect(studyLogFile(STUDY, 7)).toBe(
      [STUDY.repoPath, ".autoresearch", "gpt-4070", "logs", "7.log"].join(sep),
    );
    expect(studyMetricsFile(STUDY, 7)).not.toBe(studyLogFile(STUDY, 7));
  });
});

describe("EXCLUDES_FILE_CONTENT", () => {
  const patterns = EXCLUDES_FILE_CONTENT.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  it("hides the generated files the framework would otherwise see in git status", () => {
    expect(patterns).toEqual(["run.log", "checkpoint_pre_eval.pt", "*.tmp", ".autoresearch/"]);
  });

  it("does not exclude results.tsv, which upstream commits so tampering shows as a diff", () => {
    expect(patterns).not.toContain("results.tsv");
    expect(EXCLUDES_FILE_CONTENT).not.toMatch(/^results\.tsv$/m);
  });

  it("states that the file is framework-owned rather than the tracked .gitignore", () => {
    expect(EXCLUDES_FILE_CONTENT).toContain("Managed by Paperclip");
    expect(EXCLUDES_FILE_CONTENT.toLowerCase()).toContain(".gitignore");
    expect(EXCLUDES_FILE_CONTENT.toLowerCase()).toContain("core.excludesfile");
  });

  it("ends with a trailing newline so git never treats the last rule as unterminated", () => {
    expect(EXCLUDES_FILE_CONTENT.endsWith("\n")).toBe(true);
  });
});
