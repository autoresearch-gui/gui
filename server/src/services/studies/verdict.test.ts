import { describe, expect, it } from "vitest";

import { computeNoiseFloor, resolveVerdict, type VerdictInput } from "./verdict.js";

/** A fully specified candidate; tests override only the field under study. */
function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    valBpb: 0.9979,
    complexityDeltaLines: 0,
    bestValBpb: 1.0,
    noiseFloorBpb: 0.01,
    isBaseline: false,
    simplificationKeepsInWindow: 0,
    maxSimplificationKeepsPerWindow: 2,
    valBpbCeiling: null,
    ...overrides,
  };
}

describe("computeNoiseFloor", () => {
  it("returns null for zero values", () => {
    expect(computeNoiseFloor([])).toBeNull();
  });

  it("returns null for a single value because spread needs two samples", () => {
    expect(computeNoiseFloor([0.997])).toBeNull();
  });

  it("returns the range of two values", () => {
    expect(computeNoiseFloor([0.997, 1.004])).toBeCloseTo(0.007, 10);
  });

  it("returns max minus min across three baseline runs", () => {
    expect(computeNoiseFloor([0.9974, 1.0012, 0.9989])).toBeCloseTo(0.0038, 10);
  });

  it("ignores non-finite samples", () => {
    expect(computeNoiseFloor([Number.NaN, 0.997, 1.004, Number.POSITIVE_INFINITY])).toBeCloseTo(
      0.007,
      10,
    );
  });
});

describe("resolveVerdict", () => {
  it("treats a missing val_bpb as a crash and resets the branch", () => {
    const decision = resolveVerdict(input({ valBpb: null }));
    expect(decision.verdict).toBe("crash");
    expect(decision.gitAction).toBe("reset_to_sha");
    expect(decision.verdictReason).toBe("val_bpb_regressed");
    expect(decision.metricCredit).toBe(false);
    expect(decision.updatesBest).toBe(false);
    expect(decision.simplificationKeep).toBe(false);
    expect(decision.explanation).toContain("did not produce a val_bpb");
  });

  it("keeps the first successful run as the incumbent", () => {
    const decision = resolveVerdict(input({ valBpb: 0.9979, bestValBpb: null }));
    expect(decision.verdict).toBe("keep");
    expect(decision.gitAction).toBe("advanced");
    expect(decision.verdictReason).toBe("val_bpb_improved");
    expect(decision.metricCredit).toBe(true);
    expect(decision.updatesBest).toBe(true);
  });

  it("keeps a baseline run for the record without requiring it to win", () => {
    const decision = resolveVerdict(input({ isBaseline: true, valBpb: 1.004 }));
    expect(decision.verdict).toBe("keep");
    expect(decision.gitAction).toBe("advanced");
    expect(decision.metricCredit).toBe(true);
    expect(decision.updatesBest).toBe(false);
  });

  it("advances and credits an improvement that clears the noise floor", () => {
    const decision = resolveVerdict(input({ valBpb: 0.97, bestValBpb: 1.0, noiseFloorBpb: 0.01 }));
    expect(decision.verdict).toBe("keep");
    expect(decision.gitAction).toBe("advanced");
    expect(decision.verdictReason).toBe("val_bpb_improved");
    expect(decision.metricCredit).toBe(true);
    expect(decision.updatesBest).toBe(true);
  });

  it("falls back to a zero floor when no spread has been measured", () => {
    // The same 0.0005 gain is an improvement with no measured spread and pure
    // noise once the baseline spread is known.
    expect(resolveVerdict(input({ valBpb: 0.9995, bestValBpb: 1.0, noiseFloorBpb: null })).verdict).toBe(
      "keep",
    );
    expect(
      resolveVerdict(input({ valBpb: 0.9995, bestValBpb: 1.0, noiseFloorBpb: 0.01 })).verdict,
    ).toBe("discard");
  });

  it("resets a genuine regression even when the code got simpler", () => {
    const decision = resolveVerdict(
      input({ valBpb: 1.05, bestValBpb: 1.0, complexityDeltaLines: -40 }),
    );
    expect(decision.verdict).toBe("discard");
    expect(decision.gitAction).toBe("reset_to_sha");
    expect(decision.verdictReason).toBe("val_bpb_regressed");
    expect(decision.metricCredit).toBe(false);
    expect(decision.simplificationKeep).toBe(false);
    expect(decision.updatesBest).toBe(false);
  });

  it("adopts a simplification inside the noise band without claiming a metric win", () => {
    const decision = resolveVerdict(
      input({ valBpb: 1.004, bestValBpb: 1.0, noiseFloorBpb: 0.01, complexityDeltaLines: -37 }),
    );
    expect(decision.verdict).toBe("keep");
    expect(decision.gitAction).toBe("adopt_simplification");
    expect(decision.verdictReason).toBe("simplification_win");
    expect(decision.metricCredit).toBe(false);
    expect(decision.updatesBest).toBe(false);
    expect(decision.simplificationKeep).toBe(true);
    expect(decision.explanation).toContain("37 lines");
  });

  it("discards a within-noise change that made the model bigger", () => {
    const decision = resolveVerdict(
      input({ valBpb: 1.004, bestValBpb: 1.0, noiseFloorBpb: 0.01, complexityDeltaLines: 120 }),
    );
    expect(decision.verdict).toBe("discard");
    expect(decision.gitAction).toBe("reset_to_sha");
    expect(decision.verdictReason).toBe("within_noise_equal");
    expect(decision.simplificationKeep).toBe(false);
  });

  it("discards a within-noise simplification once the window budget is spent", () => {
    const decision = resolveVerdict(
      input({
        valBpb: 1.004,
        bestValBpb: 1.0,
        noiseFloorBpb: 0.01,
        complexityDeltaLines: -12,
        simplificationKeepsInWindow: 2,
        maxSimplificationKeepsPerWindow: 2,
      }),
    );
    expect(decision.verdict).toBe("discard");
    expect(decision.gitAction).toBe("reset_to_sha");
    expect(decision.verdictReason).toBe("within_noise_equal");
    expect(decision.simplificationKeep).toBe(false);
    expect(decision.explanation).toContain("simplification keep");
  });

  it("lets the operator ceiling override an otherwise keepable run", () => {
    const decision = resolveVerdict(
      input({ valBpb: 1.002, bestValBpb: 1.0, valBpbCeiling: 1.0, complexityDeltaLines: -5 }),
    );
    expect(decision.verdict).toBe("discard");
    expect(decision.gitAction).toBe("reset_to_sha");
    expect(decision.verdictReason).toBe("val_bpb_regressed");
    expect(decision.simplificationKeep).toBe(false);
    expect(decision.explanation).toContain("operator ceiling");
  });

  it("lets the operator ceiling override a baseline run", () => {
    const decision = resolveVerdict(input({ isBaseline: true, valBpb: 1.4, valBpbCeiling: 1.2 }));
    expect(decision.verdict).toBe("discard");
    expect(decision.explanation).toContain("operator ceiling");
  });

  it("treats an unknown complexity delta inside noise as no simplification", () => {
    const decision = resolveVerdict(
      input({ valBpb: 1.004, bestValBpb: 1.0, complexityDeltaLines: null }),
    );
    expect(decision.verdict).toBe("discard");
    expect(decision.gitAction).toBe("reset_to_sha");
  });
});