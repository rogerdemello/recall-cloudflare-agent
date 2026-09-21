import { describe, expect, it } from "vitest";
import { parseGradeResponse } from "../src/server/grading";

describe("parseGradeResponse — well-formed output", () => {
  it("reads the documented format", () => {
    const result = parseGradeResponse(
      "GRADE: 4\nFEEDBACK: You got the core idea, but missed the hibernation detail.",
    );
    expect(result.grade).toBe(4);
    expect(result.feedback).toBe(
      "You got the core idea, but missed the hibernation detail.",
    );
  });

  it("accepts every grade in range", () => {
    for (let g = 0; g <= 5; g++) {
      expect(parseGradeResponse(`GRADE: ${g}\nFEEDBACK: ok`).grade).toBe(g);
    }
  });

  it("tolerates markdown bolding the model adds unprompted", () => {
    const result = parseGradeResponse("**GRADE:** 5\n**FEEDBACK:** Exactly right.");
    expect(result.grade).toBe(5);
    expect(result.feedback).toBe("Exactly right.");
  });

  it("tolerates lowercase labels and dash separators", () => {
    const result = parseGradeResponse("grade - 2\nfeedback - Not quite there.");
    expect(result.grade).toBe(2);
    expect(result.feedback).toBe("Not quite there.");
  });

  it("keeps multi-line feedback intact", () => {
    const result = parseGradeResponse(
      "GRADE: 3\nFEEDBACK: Partly right.\nThe second half was the gap.",
    );
    expect(result.feedback).toContain("Partly right.");
    expect(result.feedback).toContain("The second half was the gap.");
  });
});

describe("parseGradeResponse — malformed output", () => {
  it("falls back to a bare leading digit", () => {
    const result = parseGradeResponse("4 — solid answer, small gap on eviction.");
    expect(result.grade).toBe(4);
    expect(result.feedback).toBe("solid answer, small gap on eviction.");
  });

  it("defaults to the lowest passing grade when no grade is present", () => {
    // A parse failure is our bug, not the learner's. Recording it as a lapse
    // would wipe out a repetition chain they actually earned.
    const result = parseGradeResponse("That's a reasonable attempt at the idea.");
    expect(result.grade).toBe(3);
    expect(result.feedback).toBe("That's a reasonable attempt at the idea.");
  });

  it("never throws on empty input", () => {
    expect(() => parseGradeResponse("")).not.toThrow();
    expect(parseGradeResponse("").grade).toBe(3);
  });

  it("supplies feedback when the model gives a grade and nothing else", () => {
    const result = parseGradeResponse("GRADE: 5");
    expect(result.grade).toBe(5);
    expect(result.feedback.length).toBeGreaterThan(0);
  });

  it("clamps an out-of-range grade rather than trusting it", () => {
    // "GRADE: 9" cannot match [0-5], so this exercises the no-grade fallback
    // rather than producing a 9 that SM-2 would treat as a wildly good recall.
    const result = parseGradeResponse("GRADE: 9\nFEEDBACK: Superb.");
    expect(result.grade).toBeLessThanOrEqual(5);
    expect(result.grade).toBeGreaterThanOrEqual(0);
  });

  it("always returns non-empty feedback", () => {
    const inputs = ["", "GRADE: 0", "nonsense", "5", "GRADE: 3\nFEEDBACK:   "];
    for (const input of inputs) {
      expect(parseGradeResponse(input).feedback.trim().length).toBeGreaterThan(0);
    }
  });
});
