import { describe, expect, it } from "vitest";
import {
  DEFAULT_EASE,
  MIN_EASE,
  NEW_CARD,
  cardMastery,
  deckMastery,
  dueTimestamp,
  isPass,
  nextInterval,
  type Grade,
  type ReviewStats,
} from "../src/server/sm2";

describe("isPass", () => {
  it("treats 3 as the lowest passing grade", () => {
    expect(isPass(2)).toBe(false);
    expect(isPass(3)).toBe(true);
  });
});

describe("nextInterval — successful recall", () => {
  it("sends a brand new card to 1 day", () => {
    const result = nextInterval(NEW_CARD, 5);
    expect(result.intervalDays).toBe(1);
    expect(result.repetitions).toBe(1);
  });

  it("sends the second success to the fixed 6-day interval", () => {
    const first = nextInterval(NEW_CARD, 5);
    const second = nextInterval(first, 4);
    expect(second.intervalDays).toBe(6);
    expect(second.repetitions).toBe(2);
  });

  it("multiplies by the ease factor from the third success onward", () => {
    // Reach repetitions=2 at a known ease of 2.6 (one +0.1 from a grade of 5,
    // then a grade of 4 which is ease-neutral).
    const second: ReviewStats = { ease: 2.6, intervalDays: 6, repetitions: 2 };
    const third = nextInterval(second, 4);
    // 6 * 2.6 = 15.6 -> 16
    expect(third.intervalDays).toBe(16);
    expect(third.repetitions).toBe(3);
  });

  it("computes the interval from the pre-update ease, per the original algorithm", () => {
    // SM-2 orders this deliberately: I(n) := I(n-1) * EF, and only *then* is EF
    // adjusted. Using the post-update ease here would inflate every interval.
    const prior: ReviewStats = { ease: 2.0, intervalDays: 10, repetitions: 3 };
    const result = nextInterval(prior, 5);
    expect(result.intervalDays).toBe(20); // 10 * 2.0, not 10 * 2.1
    expect(result.ease).toBe(2.1);
  });

  it("never returns an interval below one day", () => {
    const prior: ReviewStats = { ease: MIN_EASE, intervalDays: 0, repetitions: 5 };
    expect(nextInterval(prior, 5).intervalDays).toBeGreaterThanOrEqual(1);
  });
});

describe("nextInterval — ease factor", () => {
  it("rewards a perfect grade with +0.1", () => {
    expect(nextInterval(NEW_CARD, 5).ease).toBe(2.6);
  });

  it("leaves ease untouched on a grade of 4", () => {
    expect(nextInterval(NEW_CARD, 4).ease).toBe(DEFAULT_EASE);
  });

  it("penalises a hesitant pass", () => {
    expect(nextInterval(NEW_CARD, 3).ease).toBe(2.36);
  });

  it("clamps ease at the 1.3 floor no matter how many hesitant passes", () => {
    let stats: ReviewStats = { ...NEW_CARD };
    for (let i = 0; i < 40; i++) stats = nextInterval(stats, 3);
    expect(stats.ease).toBe(MIN_EASE);
    expect(stats.ease).toBeGreaterThanOrEqual(MIN_EASE);
  });
});

describe("nextInterval — lapse", () => {
  it("restarts the repetition chain and shows the card again tomorrow", () => {
    const mature: ReviewStats = { ease: 2.8, intervalDays: 40, repetitions: 6 };
    const lapsed = nextInterval(mature, 1);
    expect(lapsed.repetitions).toBe(0);
    expect(lapsed.intervalDays).toBe(1);
  });

  it("leaves the ease factor unchanged on a lapse", () => {
    // This is the detail most SM-2 reimplementations get wrong. The original
    // restarts repetitions "without changing the E-Factor".
    const mature: ReviewStats = { ease: 2.8, intervalDays: 40, repetitions: 6 };
    expect(nextInterval(mature, 0).ease).toBe(2.8);
    expect(nextInterval(mature, 2).ease).toBe(2.8);
  });

  it("rebuilds through the fixed intervals after a lapse", () => {
    const lapsed = nextInterval({ ease: 2.5, intervalDays: 40, repetitions: 6 }, 1);
    expect(nextInterval(lapsed, 5).intervalDays).toBe(1);
  });
});

describe("nextInterval — purity", () => {
  it("does not mutate the input", () => {
    const original: ReviewStats = { ease: 2.5, intervalDays: 10, repetitions: 3 };
    const snapshot = { ...original };
    nextInterval(original, 5);
    expect(original).toEqual(snapshot);
  });

  it("accepts every valid grade without throwing", () => {
    const grades: Grade[] = [0, 1, 2, 3, 4, 5];
    for (const grade of grades) {
      expect(() => nextInterval(NEW_CARD, grade)).not.toThrow();
    }
  });
});

describe("mastery", () => {
  it("scores an unseen card at zero", () => {
    expect(cardMastery({ intervalDays: 0 })).toBe(0);
  });

  it("scales linearly up to the 21-day threshold", () => {
    expect(cardMastery({ intervalDays: 21 })).toBe(1);
    expect(cardMastery({ intervalDays: 10.5 })).toBe(0.5);
  });

  it("clamps rather than exceeding 1 for very mature cards", () => {
    expect(cardMastery({ intervalDays: 365 })).toBe(1);
  });

  it("averages across a deck", () => {
    expect(deckMastery([{ intervalDays: 21 }, { intervalDays: 0 }])).toBe(0.5);
  });

  it("returns 0 for an empty deck instead of NaN", () => {
    expect(deckMastery([])).toBe(0);
    expect(Number.isNaN(deckMastery([]))).toBe(false);
  });
});

describe("dueTimestamp", () => {
  const now = 1_700_000_000_000;

  it("converts days to milliseconds at real time scale", () => {
    expect(dueTimestamp(1, now, 86_400)).toBe(now + 86_400_000);
  });

  it("honours a compressed demo time scale", () => {
    // 30s per "day" is what makes the scheduler observable in a live demo.
    expect(dueTimestamp(6, now, 30)).toBe(now + 180_000);
  });

  it("handles a zero interval as due immediately", () => {
    expect(dueTimestamp(0, now, 86_400)).toBe(now);
  });
});
