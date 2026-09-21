/**
 * The agent's memory, in three layers.
 *
 *  1. **SQLite** (`schema.ts`) — the source of truth. Cards, reviews, the full
 *     transcript. Never summarised, never lossy.
 *  2. **Vectorize** — semantic index over cards, so recall works on meaning
 *     rather than keywords, and so the deck builder can spot near-duplicates
 *     that a `LIKE` query would sail straight past.
 *  3. **Rolling summary** — a compressed account of older turns, kept in the
 *     `profile` table, that lets a 24k-token model behave as though it
 *     remembers a conversation far longer than its context window.
 *
 * Layer 2 is optional. With `MEMORY_MODE="sql"` the agent degrades to keyword
 * search and literal dedup, and everything else still works — a reviewer
 * without a provisioned Vectorize index can still run the project.
 */

import { embedMany, generateText, type ModelMessage } from "ai";
import { chatModel, embeddingModel, estimateTokens } from "./model";
import {
  countMessages,
  getProfile,
  recentMessages,
  searchCardsByKeyword,
  setProfile,
  type CardRow,
  type SqlHost,
} from "./schema";

/**
 * Cosine similarity above which two cards are treated as the same card.
 *
 * Tuned by hand against generated decks: 0.92 reliably catches rephrasings
 * ("What is a Durable Object?" vs "Define a Durable Object") while leaving
 * genuinely distinct questions about the same topic alone. Lower values
 * started discarding good cards.
 */
export const DUPLICATE_THRESHOLD = 0.92;

/** How many turns to keep verbatim before the summary takes over. */
const VERBATIM_TURNS = 12;
/** Summarise once the transcript passes this many turns. */
const SUMMARY_TRIGGER_TURNS = 16;
/** Re-summarise every N new turns after that. */
const SUMMARY_INTERVAL_TURNS = 10;
/** Token budget for history. Well under the model's 24k to leave room for
 *  the system prompt, tool schemas, retrieved cards and the reply itself. */
const HISTORY_TOKEN_BUDGET = 6_000;

const SUMMARY_KEY = "conversation_summary";
const SUMMARY_AT_COUNT_KEY = "conversation_summary_at_count";

export type MemoryMode = "vector" | "sql";

export function memoryMode(env: Env): MemoryMode {
  return (env.MEMORY_MODE as string) === "sql" ? "sql" : "vector";
}

// ---------------------------------------------------------------------------
// Embeddings + Vectorize
// ---------------------------------------------------------------------------

/** The text we embed for a card — question and answer together read better
 *  than either alone, since learners ask about answers as often as questions. */
function cardText(card: Pick<CardRow, "question" | "answer">): string {
  return `${card.question}\n${card.answer}`;
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedMany({
    model: embeddingModel(env),
    values: texts,
  });
  return embeddings;
}

/**
 * Index cards for semantic recall.
 *
 * `namespace` is the agent instance name. One Vectorize index is shared across
 * every learner — namespacing is what keeps one learner's recall from reaching
 * into another's cards.
 */
export async function indexCards(
  env: Env,
  namespace: string,
  cards: CardRow[],
): Promise<void> {
  if (memoryMode(env) === "sql" || cards.length === 0) return;

  const vectors = await embedTexts(env, cards.map(cardText));
  await env.MEMORY_INDEX.upsert(
    cards.map((card, i) => ({
      id: card.id,
      values: vectors[i]!,
      namespace,
      metadata: {
        deck: card.deck,
        question: card.question.slice(0, 512),
        answer: card.answer.slice(0, 512),
      },
    })),
  );
}

export interface RecalledCard {
  id: string;
  deck: string;
  question: string;
  answer: string;
  score: number;
}

/**
 * Find cards related to a query by meaning.
 *
 * Falls back to SQL keyword search when Vectorize is disabled, so callers never
 * need to branch on memory mode themselves.
 */
export async function recall(
  env: Env,
  host: SqlHost,
  namespace: string,
  query: string,
  topK = 5,
): Promise<RecalledCard[]> {
  if (memoryMode(env) === "sql") {
    return searchCardsByKeyword(host, query, topK).map((card) => ({
      id: card.id,
      deck: card.deck,
      question: card.question,
      answer: card.answer,
      score: 1,
    }));
  }

  const [vector] = await embedTexts(env, [query]);
  if (!vector) return [];

  const result = await env.MEMORY_INDEX.query(vector, {
    topK,
    namespace,
    returnMetadata: true,
  });

  return result.matches.map((match) => ({
    id: match.id,
    deck: String(match.metadata?.deck ?? "general"),
    question: String(match.metadata?.question ?? ""),
    answer: String(match.metadata?.answer ?? ""),
    score: match.score,
  }));
}

/**
 * Decide which of a batch of candidate cards are semantic duplicates of cards
 * already indexed.
 *
 * Used by the deck-building workflow: an LLM asked for cards on eight subtopics
 * will happily produce the same fact three times in different words, and a
 * literal question-match check catches none of it.
 *
 * @returns a boolean per candidate, index-aligned with the input.
 */
export async function flagDuplicates(
  env: Env,
  namespace: string,
  candidates: Pick<CardRow, "question" | "answer">[],
): Promise<boolean[]> {
  if (memoryMode(env) === "sql" || candidates.length === 0) {
    return candidates.map(() => false);
  }

  const vectors = await embedTexts(env, candidates.map(cardText));

  // Check each candidate against the index, then against the candidates already
  // accepted in this same batch — otherwise two duplicates inside one batch both
  // survive, since neither is in the index yet.
  const accepted: number[][] = [];
  const flags: boolean[] = [];

  for (const vector of vectors) {
    if (!vector) {
      flags.push(false);
      continue;
    }

    const existing = await env.MEMORY_INDEX.query(vector, {
      topK: 1,
      namespace,
      returnMetadata: false,
    });
    const topScore = existing.matches[0]?.score ?? 0;
    const dupOfIndexed = topScore >= DUPLICATE_THRESHOLD;

    const dupOfBatch = accepted.some(
      (other) => cosineSimilarity(vector, other) >= DUPLICATE_THRESHOLD,
    );

    const isDuplicate = dupOfIndexed || dupOfBatch;
    if (!isDuplicate) accepted.push(vector);
    flags.push(isDuplicate);
  }

  return flags;
}

/** Plain cosine similarity for in-batch comparisons that never touch the index. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Drop a card's vector when the card itself is deleted. */
export async function forgetCards(
  env: Env,
  ids: string[],
): Promise<void> {
  if (memoryMode(env) === "sql" || ids.length === 0) return;
  await env.MEMORY_INDEX.deleteByIds(ids);
}

// ---------------------------------------------------------------------------
// Rolling summary — how a 24k model holds a long conversation
// ---------------------------------------------------------------------------

export function storedSummary(host: SqlHost): string | null {
  return getProfile(host, SUMMARY_KEY);
}

/**
 * Regenerate the conversation summary if the transcript has grown enough since
 * the last one.
 *
 * Cheap to call on every turn — it early-returns unless a threshold is crossed.
 */
export async function maybeSummarise(
  env: Env,
  host: SqlHost,
  now: number,
): Promise<void> {
  const total = countMessages(host);
  if (total < SUMMARY_TRIGGER_TURNS) return;

  const lastAt = Number(getProfile(host, SUMMARY_AT_COUNT_KEY) ?? 0);
  if (total - lastAt < SUMMARY_INTERVAL_TURNS) return;

  // Summarise everything except the turns that will still be sent verbatim,
  // so the summary and the verbatim window don't overlap and waste context.
  const all = recentMessages(host, total);
  const older = all.slice(0, Math.max(0, all.length - VERBATIM_TURNS));
  if (older.length === 0) return;

  const previous = storedSummary(host);
  const transcript = older
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  try {
    const { text } = await generateText({
      model: chatModel(env),
      system:
        "You compress a tutoring conversation into durable notes. Keep: what " +
        "the learner is studying, their stated goals, misconceptions they have " +
        "shown, topics already covered, and their apparent level. Drop " +
        "pleasantries and anything transient. Write terse third-person bullet " +
        "points, no preamble, 200 words maximum.",
      prompt: previous
        ? `Existing notes:\n${previous}\n\nNewer conversation to fold in:\n${transcript}\n\nReturn the merged notes.`
        : `Conversation:\n${transcript}\n\nReturn the notes.`,
    });

    setProfile(host, SUMMARY_KEY, text.trim(), now);
    setProfile(host, SUMMARY_AT_COUNT_KEY, String(total), now);
  } catch (error) {
    // A failed summary is not worth failing the user's turn over — the verbatim
    // window still carries recent context, and we retry on the next threshold.
    console.error("summary generation failed", error);
  }
}

/**
 * Assemble the message list sent to the model.
 *
 * Order matters: durable notes first (stable across turns, so the prefix cache
 * can hit), then the verbatim tail. Trimmed to a token budget from the newest
 * end backwards, so the most recent turn is never the one that gets dropped.
 */
export function buildHistory(host: SqlHost): ModelMessage[] {
  const messages: ModelMessage[] = [];

  const summary = storedSummary(host);
  if (summary) {
    messages.push({
      role: "system",
      content: `Notes from earlier sessions with this learner:\n${summary}`,
    });
  }

  const recent = recentMessages(host, VERBATIM_TURNS);
  let budget = HISTORY_TOKEN_BUDGET;
  const kept: ModelMessage[] = [];

  for (let i = recent.length - 1; i >= 0; i--) {
    const row = recent[i]!;
    const cost = estimateTokens(row.content);
    if (cost > budget) break;
    budget -= cost;
    kept.unshift({
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
    });
  }

  return [...messages, ...kept];
}
