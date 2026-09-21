/**
 * SM-2 spaced repetition.
 *
 * Faithful to Wozniak's original SuperMemo 2 description, including the detail
 * most reimplementations get wrong: on a failed recall the E-Factor is left
 * *unchanged* and only the repetition chain restarts. (The original: "If the
 * quality response was lower than 3 then start repetitions for the item from
 * the beginning without changing the E-Factor.")
 *
 * Deliberately pure — no clock, no I/O, no database. Every scheduling decision
 * in the agent flows through `nextInterval`, so unit tests cover the one piece
 * of real algorithmic logic in the project without needing a Worker runtime.
 */

/** Recall quality, 0 (blackout) to 5 (perfect). */
export type Grade = 0 | 1 | 2 | 3 | 4 | 5;

export interface ReviewStats {
  /** E-Factor: how fast intervals grow for this card. */
  ease: number;
  /** Days until this card should next be shown. */
  intervalDays: number;
  /** Length of the current unbroken chain of successful recalls. */
  repetitions: number;
}

/** Floor from the original algorithm — below this, intervals stop growing usefully. */
export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;
/** Grades below this count as a lapse. */
export const PASS_THRESHOLD = 3;
/** Interval at which a card is considered learned, used for the mastery metric. */
export const MASTERY_INTERVAL_DAYS = 21;

export const NEW_CARD: ReviewStats = {
  ease: DEFAULT_EASE,
  intervalDays: 0,
  repetitions: 0,
};

export function isPass(grade: Grade): boolean {
  return grade >= PASS_THRESHOLD;
}

/**
 * Apply a grade to a card's scheduling stats.
 *
 * @returns the card's new stats — never mutates the input.
 */
export function nextInterval(prev: ReviewStats, grade: Grade): ReviewStats {
  if (!isPass(grade)) {
    // Lapse: restart the chain, show again tomorrow, leave ease alone.
    return { ease: prev.ease, intervalDays: 1, repetitions: 0 };
  }

  const delta = 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02);
  const ease = Math.max(MIN_EASE, round2(prev.ease + delta));
  const repetitions = prev.repetitions + 1;

  // First two successes use fixed intervals; after that the ease factor drives growth.
  const intervalDays =
    repetitions === 1
      ? 1
      : repetitions === 2
        ? 6
        : Math.max(1, Math.round(prev.intervalDays * prev.ease));

  return { ease, intervalDays, repetitions };
}

/**
 * Per-card progress toward "learned", clamped to 0..1.
 *
 * A card sitting at a 21-day interval or longer counts as fully mastered.
 */
export function cardMastery(stats: Pick<ReviewStats, "intervalDays">): number {
  if (stats.intervalDays <= 0) return 0;
  return Math.min(1, stats.intervalDays / MASTERY_INTERVAL_DAYS);
}

/** Mean mastery across a deck. Returns 0 for an empty deck rather than NaN. */
export function deckMastery(cards: Pick<ReviewStats, "intervalDays">[]): number {
  if (cards.length === 0) return 0;
  const total = cards.reduce((sum, card) => sum + cardMastery(card), 0);
  return round2(total / cards.length);
}

/**
 * Convert an SM-2 interval in days to a wall-clock due timestamp.
 *
 * `secondsPerDay` is configurable purely so the product is demonstrable: at the
 * real 86 400 a reviewer would have to come back tomorrow to see the scheduler
 * fire. Compressing a "day" to ~30s lets the same code path be observed live.
 * The algorithm itself is untouched — only the unit of time is scaled.
 */
export function dueTimestamp(
  intervalDays: number,
  now: number,
  secondsPerDay: number,
): number {
  return now + Math.round(intervalDays * secondsPerDay * 1000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
