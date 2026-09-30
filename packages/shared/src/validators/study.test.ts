import { describe, expect, it } from "vitest";
import { EXPERIMENT_GIT_ACTIONS, EXPERIMENT_VERDICTS } from "../constants.js";
import { createStudySchema, recordVerdictSchema } from "./study.js";

describe("study validators", () => {
  it("keeps the experiment verdict enum at the three upstream results.tsv values", () => {
    expect(EXPERIMENT_VERDICTS).toEqual(["keep", "discard", "crash"]);
  });

  it("allows the simplification git action", () => {
    expect(EXPERIMENT_GIT_ACTIONS).toContain("adopt_simplification");
  });

  it("applies study defaults on create", () => {
    const parsed = createStudySchema.parse({
      name: "Scaling study",
      tag: "scaling",
      baseRef: "main",
      repoPath: "/repos/nanochat",
    });

    expect(parsed.timeBudgetSec).toBe(300);
    expect(parsed.status).toBe("setup");
    expect(parsed.isBaselineRequired).toBe(true);
  });

  it("rejects a study tag that is not branch safe", () => {
    const result = createStudySchema.safeParse({
      name: "Scaling study",
      tag: "scaling study",
      baseRef: "main",
      repoPath: "/repos/nanochat",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a simplification win verdict with an expected revision", () => {
    const parsed = recordVerdictSchema.parse({
      verdict: "keep",
      verdictReason: "simplification_win",
      complexityDeltaLines: -42,
      expectedRevision: 3,
    });

    expect(parsed.verdictReason).toBe("simplification_win");
    expect(parsed.expectedRevision).toBe(3);
  });
});