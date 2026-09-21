/**
 * Wire protocol shared by the Worker and the browser.
 *
 * Kept in one file so the client and server can never drift: both tsconfigs
 * include `src/shared`, so a change to a message shape breaks compilation on
 * whichever side forgot to keep up.
 *
 * Agent *state* is not carried here — the Agents SDK syncs `CoachState`
 * automatically over its own `cf_agent_state` frames, surfaced in the browser
 * through `AgentClient`'s `onStateUpdate` callback. These messages are the
 * things state sync can't express: token streams and one-shot events.
 */

/** Chat turn as stored in SQLite and replayed to the UI. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
}

/** A single deck's rollup, cheap enough to keep in synced state. */
export interface DeckSummary {
  deck: string;
  cardCount: number;
  dueCount: number;
}

/** Live progress of a running DeckBuilder workflow. */
export interface WorkflowProgress {
  id: string;
  topic: string;
  /** Human-readable description of the step in flight. */
  label: string;
  done: number;
  total: number;
  status: "running" | "complete" | "error";
}

/** The card currently being quizzed, if any. */
export interface ActiveReview {
  cardId: string;
  question: string;
  deck: string;
  /** Set once the learner asks to see the answer without attempting it. */
  revealed: boolean;
}

/**
 * Agent state, auto-synced to every connected client on change.
 *
 * Deliberately small: this is broadcast on every mutation, so bulk data
 * (cards, transcript, review log) stays in SQLite and is fetched on demand.
 */
export interface CoachState {
  cardCount: number;
  dueCount: number;
  decks: DeckSummary[];
  /** 0..1, mean per-card progress toward the 21-day "learned" threshold. */
  mastery: number;
  streakDays: number;
  reviewsCompleted: number;
  activeReview: ActiveReview | null;
  workflow: WorkflowProgress | null;
  memoryMode: "vector" | "sql";
  /** True while the model is generating, so the UI can disable the composer. */
  thinking: boolean;
}

export const INITIAL_COACH_STATE: CoachState = {
  cardCount: 0,
  dueCount: 0,
  decks: [],
  mastery: 0,
  streakDays: 0,
  reviewsCompleted: 0,
  activeReview: null,
  workflow: null,
  memoryMode: "vector",
  thinking: false,
};

/** Browser → Worker. */
export type ClientMessage =
  | { type: "chat"; id: string; text: string }
  | { type: "history" }
  | { type: "skip_review" }
  | { type: "reveal_answer" }
  | { type: "start_review" }
  | { type: "reset" };

/** Worker → browser. */
export type ServerMessage =
  /** First token of an assistant turn; the UI opens a bubble. */
  | { type: "start"; id: string }
  /** Incremental text for an open bubble. */
  | { type: "token"; id: string; delta: string }
  /** Assistant turn finished and has been persisted. */
  | { type: "done"; id: string; content: string }
  /** Full transcript replay on connect. */
  | { type: "history"; messages: ChatMessage[] }
  /** A tool call started — shown as an inline activity chip. */
  | { type: "tool"; id: string; name: string; label: string }
  /** The agent is quizzing the learner, usually unprompted. */
  | { type: "review_start"; cardId: string; question: string; deck: string }
  /** Result of grading the learner's answer. */
  | {
      type: "review_result";
      cardId: string;
      grade: number;
      passed: boolean;
      feedback: string;
      correctAnswer: string;
      nextDueInDays: number;
    }
  /** Nothing was due when a review was requested. */
  | { type: "review_none" }
  | { type: "error"; message: string };
