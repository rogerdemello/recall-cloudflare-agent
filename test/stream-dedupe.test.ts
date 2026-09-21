import { describe, expect, it } from "vitest";
import { DeltaDeduper } from "../src/server/stream-dedupe";

/** Run a whole delta sequence through the deduper and join the result. */
function run(deltas: string[]): string[] {
  const deduper = new DeltaDeduper();
  const out: string[] = [];
  for (const delta of deltas) out.push(...deduper.push(delta));
  out.push(...deduper.flush());
  return out;
}

describe("DeltaDeduper — the actual bug", () => {
  it("undoes the doubling captured from live Workers AI", () => {
    // Verbatim from the minimal repro against workers-ai-provider@4.0.0.
    const observed = [
      "D",
      "D",
      "urable Objects are",
      "urable Objects are",
      " stateful",
      " stateful",
      ".",
      ".",
    ];
    expect(run(observed).join("")).toBe("Durable Objects are stateful.");
  });

  it("halves the delta count", () => {
    const observed = ["a", "a", "b", "b", "c", "c"];
    expect(run(observed)).toEqual(["a", "b", "c"]);
  });

  it("handles a single doubled delta", () => {
    expect(run(["only", "only"])).toEqual(["only"]);
  });
});

describe("DeltaDeduper — text that legitimately repeats", () => {
  it("preserves a genuine repeated word under the bug", () => {
    // "the the" is emitted as four deltas by the broken provider; pairing them
    // must yield two, not one.
    expect(run(["the ", "the ", "the ", "the "]).join("")).toBe("the the ");
  });

  it("preserves repeated punctuation under the bug", () => {
    expect(run([".", ".", ".", ".", ".", "."]).join("")).toBe("...");
  });

  it("preserves repeated whitespace under the bug", () => {
    expect(run([" ", " ", " ", " "]).join("")).toBe("  ");
  });
});

describe("DeltaDeduper — pass-through behaviour", () => {
  it("leaves a non-duplicated stream intact", () => {
    const deltas = ["Hello", " ", "world", "!"];
    expect(run(deltas)).toEqual(deltas);
  });

  it("emits nothing for an empty stream", () => {
    expect(run([])).toEqual([]);
  });

  it("releases a trailing unpaired delta on flush", () => {
    expect(run(["a", "a", "trailing"])).toEqual(["a", "trailing"]);
  });

  it("does not lose the final delta of an odd-length stream", () => {
    const observed = ["x", "x", "y", "y", "z"];
    expect(run(observed).join("")).toBe("xyz");
  });
});

describe("DeltaDeduper — incremental contract", () => {
  it("holds the first delta back by exactly one", () => {
    const deduper = new DeltaDeduper();
    expect(deduper.push("first")).toEqual([]);
    expect(deduper.push("second")).toEqual(["first"]);
    expect(deduper.flush()).toEqual(["second"]);
  });

  it("releases the held delta as soon as a different one arrives", () => {
    const deduper = new DeltaDeduper();
    deduper.push("a");
    expect(deduper.push("b")).toEqual(["a"]);
  });

  it("is idempotent on repeated flush", () => {
    const deduper = new DeltaDeduper();
    deduper.push("a");
    expect(deduper.flush()).toEqual(["a"]);
    expect(deduper.flush()).toEqual([]);
  });

  it("never emits more deltas than it received", () => {
    const deduper = new DeltaDeduper();
    const input = ["a", "a", "b", "c", "c", "d"];
    let emitted = 0;
    for (const d of input) emitted += deduper.push(d).length;
    emitted += deduper.flush().length;
    expect(emitted).toBeLessThanOrEqual(input.length);
  });
});
