/**
 * The agent's durable memory.
 *
 * Every learner gets their own Durable Object, and every Durable Object gets
 * its own embedded SQLite database. There is no shared table with a `user_id`
 * column anywhere in this project — isolation is a property of the runtime, not
 * something the query layer has to remember to enforce.
 *
 * `this.sql` is synchronous and returns rows directly, so these helpers read
 * like ordinary function calls rather than awaited queries.
 */

import { DEFAULT_EASE, deckMastery, type ReviewStats } from "./sm2";

/** Shape of the Agent's tagged-template SQL helper. */
export type SqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/** Anything carrying a `sql` tag — in practice, the Agent itself. */
export interface SqlHost {
  sql: SqlTag;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface CardRow {
  id: string;
  deck: string;
  question: string;
  answer: string;
  /** Where the card came from — "chat" (mined from conversation) or "deck" (workflow). */
  source: string;
  ease: number;
  interval_days: number;
  repetitions: number;
  due_at: number;
  created_at: number;
  last_reviewed_at: number | null;
  lapses: number;
}

export interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

export interface ReviewRow {
  id: string;
  card_id: string;
  grade: number;
  user_answer: string;
  feedback: string;
  reviewed_at: number;
}

export interface NewCard {
  deck: string;
  question: string;
  answer: string;
  source?: "chat" | "deck";
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Create every table this agent needs.
 *
 * Safe to call on every Durable Object wake — all statements are
 * `IF NOT EXISTS`. The Agents SDK owns its own `cf_agents_*` tables in the same
 * database; these names are distinct from those.
 */
export function migrate(host: SqlHost): void {
  host.sql`
    CREATE TABLE IF NOT EXISTS cards (
      id               TEXT PRIMARY KEY,
      deck             TEXT    NOT NULL,
      question         TEXT    NOT NULL,
      answer           TEXT    NOT NULL,
      source           TEXT    NOT NULL DEFAULT 'chat',
      ease             REAL    NOT NULL DEFAULT ${DEFAULT_EASE},
      interval_days    REAL    NOT NULL DEFAULT 0,
      repetitions      INTEGER NOT NULL DEFAULT 0,
      due_at           INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      last_reviewed_at INTEGER,
      lapses           INTEGER NOT NULL DEFAULT 0
    )
  `;
  // Due-card selection is the hottest query in the app — it runs on every
  // scheduler tick, not just when someone is looking.
  host.sql`CREATE INDEX IF NOT EXISTS idx_cards_due ON cards (due_at)`;
  host.sql`CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards (deck)`;

  host.sql`
    CREATE TABLE IF NOT EXISTS reviews (
      id          TEXT PRIMARY KEY,
      card_id     TEXT    NOT NULL,
      grade       INTEGER NOT NULL,
      user_answer TEXT    NOT NULL,
      feedback    TEXT    NOT NULL,
      reviewed_at INTEGER NOT NULL
    )
  `;
  host.sql`CREATE INDEX IF NOT EXISTS idx_reviews_time ON reviews (reviewed_at)`;

  host.sql`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      role       TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  host.sql`CREATE INDEX IF NOT EXISTS idx_messages_time ON messages (created_at)`;

  // Small key/value side table: rolling conversation summary, streak bookkeeping,
  // learner preferences the model should remember between sessions.
  host.sql`
    CREATE TABLE IF NOT EXISTS profile (
      key        TEXT PRIMARY KEY,
      value      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * Insert a card, skipping exact-duplicate questions within the same deck.
 *
 * This is only the cheap literal-match guard; semantic near-duplicates are
 * caught separately by the Vectorize pass in the deck-building workflow.
 *
 * @returns the new card's id, or null if an identical question already existed.
 */
export function insertCard(
  host: SqlHost,
  card: NewCard,
  now: number,
): string | null {
  const existing = host.sql<{ id: string }>`
    SELECT id FROM cards
    WHERE deck = ${card.deck} AND lower(question) = lower(${card.question})
    LIMIT 1
  `;
  if (existing.length > 0) return null;

  const id = crypto.randomUUID();
  host.sql`
    INSERT INTO cards (id, deck, question, answer, source, due_at, created_at)
    VALUES (
      ${id}, ${card.deck}, ${card.question}, ${card.answer},
      ${card.source ?? "chat"}, ${now}, ${now}
    )
  `;
  return id;
}

export function getCard(host: SqlHost, id: string): CardRow | null {
  const rows = host.sql<CardRow>`SELECT * FROM cards WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

/** Cards that are due now, most overdue first. */
export function dueCards(host: SqlHost, now: number, limit = 20): CardRow[] {
  return host.sql<CardRow>`
    SELECT * FROM cards
    WHERE due_at <= ${now}
    ORDER BY due_at ASC
    LIMIT ${limit}
  `;
}

export function countDue(host: SqlHost, now: number): number {
  const rows = host.sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM cards WHERE due_at <= ${now}
  `;
  return rows[0]?.n ?? 0;
}

export function countCards(host: SqlHost): number {
  const rows = host.sql<{ n: number }>`SELECT COUNT(*) AS n FROM cards`;
  return rows[0]?.n ?? 0;
}

export function listCards(host: SqlHost, deck?: string, limit = 200): CardRow[] {
  if (deck) {
    return host.sql<CardRow>`
      SELECT * FROM cards WHERE deck = ${deck} ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return host.sql<CardRow>`
    SELECT * FROM cards ORDER BY created_at DESC LIMIT ${limit}
  `;
}

/** Write back the scheduling stats produced by SM-2 after a graded review. */
export function applyReviewToCard(
  host: SqlHost,
  cardId: string,
  stats: ReviewStats,
  dueAt: number,
  now: number,
  lapsed: boolean,
): void {
  host.sql`
    UPDATE cards SET
      ease             = ${stats.ease},
      interval_days    = ${stats.intervalDays},
      repetitions      = ${stats.repetitions},
      due_at           = ${dueAt},
      last_reviewed_at = ${now},
      lapses           = lapses + ${lapsed ? 1 : 0}
    WHERE id = ${cardId}
  `;
}

/**
 * Keyword search over cards — the MEMORY_MODE="sql" fallback for when no
 * Vectorize index is provisioned. Crude by design: it exists so the app still
 * runs end-to-end without account setup, not to rival embeddings.
 */
export function searchCardsByKeyword(
  host: SqlHost,
  query: string,
  limit = 5,
): CardRow[] {
  const like = `%${query.toLowerCase().replace(/[%_]/g, "")}%`;
  return host.sql<CardRow>`
    SELECT * FROM cards
    WHERE lower(question) LIKE ${like} OR lower(answer) LIKE ${like}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export function insertReview(
  host: SqlHost,
  review: Omit<ReviewRow, "id">,
): string {
  const id = crypto.randomUUID();
  host.sql`
    INSERT INTO reviews (id, card_id, grade, user_answer, feedback, reviewed_at)
    VALUES (${id}, ${review.card_id}, ${review.grade}, ${review.user_answer},
            ${review.feedback}, ${review.reviewed_at})
  `;
  return id;
}

export function countReviews(host: SqlHost): number {
  const rows = host.sql<{ n: number }>`SELECT COUNT(*) AS n FROM reviews`;
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export function insertMessage(
  host: SqlHost,
  role: "user" | "assistant" | "system",
  content: string,
  now: number,
): MessageRow {
  const row: MessageRow = {
    id: crypto.randomUUID(),
    role,
    content,
    created_at: now,
  };
  host.sql`
    INSERT INTO messages (id, role, content, created_at)
    VALUES (${row.id}, ${row.role}, ${row.content}, ${row.created_at})
  `;
  return row;
}

/** Most recent turns, oldest-first so they can be fed straight to the model. */
export function recentMessages(host: SqlHost, limit: number): MessageRow[] {
  const rows = host.sql<MessageRow>`
    SELECT * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ${limit}
  `;
  return rows.reverse();
}

export function countMessages(host: SqlHost): number {
  const rows = host.sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages`;
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Profile (key/value)
// ---------------------------------------------------------------------------

export function getProfile(host: SqlHost, key: string): string | null {
  const rows = host.sql<{ value: string }>`
    SELECT value FROM profile WHERE key = ${key} LIMIT 1
  `;
  return rows[0]?.value ?? null;
}

export function setProfile(
  host: SqlHost,
  key: string,
  value: string,
  now: number,
): void {
  host.sql`
    INSERT INTO profile (key, value, updated_at) VALUES (${key}, ${value}, ${now})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `;
}

// ---------------------------------------------------------------------------
// Rollups for synced state
// ---------------------------------------------------------------------------

export interface DeckRollup {
  deck: string;
  cardCount: number;
  dueCount: number;
}

export function deckRollups(host: SqlHost, now: number): DeckRollup[] {
  const rows = host.sql<{ deck: string; card_count: number; due_count: number }>`
    SELECT deck,
           COUNT(*) AS card_count,
           SUM(CASE WHEN due_at <= ${now} THEN 1 ELSE 0 END) AS due_count
    FROM cards
    GROUP BY deck
    ORDER BY card_count DESC
  `;
  return rows.map((r) => ({
    deck: r.deck,
    cardCount: r.card_count,
    dueCount: r.due_count ?? 0,
  }));
}

/** Mean progress toward the 21-day "learned" threshold across every card. */
export function overallMastery(host: SqlHost): number {
  const rows = host.sql<{ interval_days: number }>`SELECT interval_days FROM cards`;
  return deckMastery(rows.map((r) => ({ intervalDays: r.interval_days })));
}

// ---------------------------------------------------------------------------
// Streak
// ---------------------------------------------------------------------------

const STREAK_DAYS_KEY = "streak_days";
const STREAK_LAST_DAY_KEY = "streak_last_day";

/**
 * Advance the study streak, counting in whole UTC days.
 *
 * Same day → unchanged. Consecutive day → +1. Any longer gap → back to 1.
 * `msPerDay` is injected rather than hard-coded so the compressed demo clock
 * used elsewhere in the app can make streaks observable too.
 */
export function touchStreak(host: SqlHost, now: number, msPerDay: number): number {
  const today = Math.floor(now / msPerDay);
  const lastDay = Number(getProfile(host, STREAK_LAST_DAY_KEY) ?? Number.NaN);
  const current = Number(getProfile(host, STREAK_DAYS_KEY) ?? 0);

  let streak: number;
  if (Number.isNaN(lastDay)) streak = 1;
  else if (today === lastDay) streak = Math.max(1, current);
  else if (today === lastDay + 1) streak = current + 1;
  else streak = 1;

  setProfile(host, STREAK_DAYS_KEY, String(streak), now);
  setProfile(host, STREAK_LAST_DAY_KEY, String(today), now);
  return streak;
}

export function currentStreak(host: SqlHost): number {
  return Number(getProfile(host, STREAK_DAYS_KEY) ?? 0);
}
