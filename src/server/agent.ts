/**
 * Recall's study coach agent.
 *
 * One Durable Object per learner. It holds the conversation, the flashcards,
 * the review schedule and the streak — and because a Durable Object can wake
 * itself, it is the thing that decides to quiz you rather than waiting to be
 * asked.
 *
 * The three jobs of this class:
 *
 *  - **Teach.** Stream a reply from Llama 3.3, letting it call tools to save
 *    cards, search memory or kick off a deck build.
 *  - **Quiz.** Wake on a schedule, pick the most overdue card, push it to the
 *    browser, and grade whatever comes back.
 *  - **Remember.** Persist everything to SQLite, mirror the semantics into
 *    Vectorize, and keep a rolling summary so a 24k-token model can hold a
 *    conversation much longer than its context window.
 */

import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { generateText, stepCountIs, streamText } from "ai";
import { GRADE_FORMAT_INSTRUCTION, parseGradeResponse } from "./grading";
import {
  buildHistory,
  flagDuplicates,
  indexCards,
  maybeSummarise,
  memoryMode,
  recall,
} from "./memory";
import { chatModel } from "./model";
import {
  applyReviewToCard,
  countCards,
  countDue,
  countReviews,
  currentStreak,
  deckRollups,
  dueCards,
  getCard,
  insertCard,
  insertMessage,
  insertReview,
  listCards,
  migrate,
  overallMastery,
  recentMessages,
  touchStreak,
  type CardRow,
} from "./schema";
import { dueTimestamp, isPass, nextInterval, type ReviewStats } from "./sm2";
import { buildTools, type ToolHost } from "./tools";
import {
  INITIAL_COACH_STATE,
  type ChatMessage,
  type ClientMessage,
  type CoachState,
  type ServerMessage,
} from "../shared/protocol";

/** Name of the scheduled callback, used when cancelling stale schedules. */
const REVIEW_CALLBACK = "runReview";

/** Cap on tool-calling rounds per turn — a guard against the model looping. */
const MAX_STEPS = 5;

/**
 * Static across every turn, on purpose.
 *
 * Injecting live stats here would change the prompt prefix each turn and defeat
 * the KV prefix cache that `sessionAffinity` exists to exploit. The model can
 * call `get_progress` when it actually needs numbers.
 */
const SYSTEM_PROMPT = `You are Recall, a study coach. You teach things, and you quietly turn what you teach into flashcards that you test the learner on later.

How you teach:
- Be concrete. A worked example beats a definition.
- Keep replies under 150 words unless asked to go deeper.
- Ask what they want to learn if they are vague, but only once — then pick something and start.

Saving cards:
- After you explain anything substantive, call add_cards.
- Do this silently. Never announce it, never ask permission, never list the cards back.
- Write questions that test understanding, not recall of your exact wording.

Using memory:
- If the learner refers to an earlier session, or asks what they have covered, call search_memory first. Never guess at what they have studied.
- Before teaching a topic, it is reasonable to check whether they already have cards on it.

Deck building:
- Only call build_deck when they explicitly ask for a deck, a course, or to study a broad topic from scratch. It runs in the background; mention it is underway and stop there.

Never mention Durable Objects, Workers, SQLite, workflows or any other implementation detail of how you work. You are a tutor, not a system.`;

export class StudyCoach extends Agent<Env, CoachState> implements ToolHost {
  initialState: CoachState = INITIAL_COACH_STATE;

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  /** Agent instance name; doubles as the Vectorize namespace. */
  get instanceName(): string {
    return this.name;
  }

  private get secondsPerDay(): number {
    return numberFromEnv(this.env.SECONDS_PER_DAY, 30);
  }

  private get firstReviewDelay(): number {
    return numberFromEnv(this.env.FIRST_REVIEW_DELAY_SECONDS, 45);
  }

  private get msPerDay(): number {
    return this.secondsPerDay * 1000;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Runs on every wake, including after hibernation — so it must be idempotent.
   * `migrate` is all `IF NOT EXISTS`, and `refreshState` only recomputes.
   */
  async onStart(): Promise<void> {
    migrate(this);
    this.refreshState();
  }

  async onConnect(connection: Connection, _ctx: ConnectionContext): Promise<void> {
    // State syncs itself via the SDK; the transcript does not, so replay it.
    this.sendTo(connection, {
      type: "history",
      messages: this.transcript(),
    });
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }
    // The SDK multiplexes its own control frames over this socket; anything
    // without a type we recognise is not ours to handle.
    if (!parsed || typeof parsed.type !== "string") return;

    try {
      switch (parsed.type) {
        case "chat":
          await this.handleUserText(parsed.text);
          break;
        case "history":
          this.sendTo(connection, { type: "history", messages: this.transcript() });
          break;
        case "start_review":
          if (!(await this.beginReview())) {
            this.sendTo(connection, { type: "review_none" });
          }
          break;
        case "skip_review":
          await this.skipReview();
          break;
        case "reveal_answer":
          this.revealAnswer();
          break;
        case "reset":
          await this.resetEverything();
          break;
      }
    } catch (error) {
      console.error("onMessage failed", error);
      this.emit({
        type: "error",
        message: "Something went wrong handling that. Try again.",
      });
      this.setState({ ...this.state, thinking: false });
    }
  }

  // -------------------------------------------------------------------------
  // Conversation
  // -------------------------------------------------------------------------

  private async handleUserText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const now = Date.now();
    insertMessage(this, "user", trimmed, now);

    // A pending quiz takes priority over ordinary chat. Routing on state here,
    // rather than letting the model decide via a tool call, is what keeps the
    // scheduling data correct even when the model is having an off turn.
    if (this.state.activeReview) {
      await this.gradeActiveReview(trimmed);
      return;
    }

    await this.respond();
  }

  /** Stream one assistant turn, running the tool loop as it goes. */
  private async respond(): Promise<void> {
    const id = crypto.randomUUID();
    this.setState({ ...this.state, thinking: true });
    this.emit({ type: "start", id });

    let full = "";
    try {
      const result = streamText({
        model: chatModel(this.env, this.sessionAffinity),
        system: SYSTEM_PROMPT,
        messages: buildHistory(this),
        tools: buildTools(this),
        stopWhen: stepCountIs(MAX_STEPS),
      });

      for await (const delta of result.textStream) {
        full += delta;
        this.emit({ type: "token", id, delta });
      }
    } catch (error) {
      console.error("generation failed", error);
      const message =
        "I lost my train of thought there — say that again and I'll pick it up.";
      this.emit({ type: "token", id, delta: message });
      full = message;
    }

    // A turn that was pure tool calls produces no text. Say *something* rather
    // than leaving an empty bubble on screen.
    if (!full.trim()) {
      full = "Done.";
      this.emit({ type: "token", id, delta: full });
    }

    const now = Date.now();
    insertMessage(this, "assistant", full, now);
    this.emit({ type: "done", id, content: full });
    this.setState({ ...this.state, thinking: false });

    await maybeSummarise(this.env, this, now);
    await this.scheduleNextReview();
  }

  // -------------------------------------------------------------------------
  // Review loop
  // -------------------------------------------------------------------------

  /**
   * Scheduled callback. Fires while nobody is typing — this is the agent
   * deciding, on its own clock, that it is time to test something.
   *
   * Public because `this.schedule()` dispatches by method name.
   */
  async runReview(): Promise<void> {
    if (this.state.activeReview) return;

    const [card] = dueCards(this, Date.now(), 1);
    if (!card) {
      await this.scheduleNextReview();
      return;
    }

    this.setState({
      ...this.state,
      activeReview: {
        cardId: card.id,
        question: card.question,
        deck: card.deck,
        revealed: false,
      },
    });

    this.emit({
      type: "review_start",
      cardId: card.id,
      question: card.question,
      deck: card.deck,
    });
    insertMessage(this, "assistant", `Quick check — ${card.question}`, Date.now());
  }

  /** Grade the learner's answer, update SM-2, and queue the next review. */
  private async gradeActiveReview(answer: string): Promise<void> {
    const active = this.state.activeReview;
    if (!active) return;

    const card = getCard(this, active.cardId);
    if (!card) {
      this.setState({ ...this.state, activeReview: null });
      return;
    }

    this.setState({ ...this.state, thinking: true });

    const { grade, feedback } = await this.gradeAnswer(card, answer, active.revealed);
    const now = Date.now();

    const prior: ReviewStats = {
      ease: card.ease,
      intervalDays: card.interval_days,
      repetitions: card.repetitions,
    };
    const updated = nextInterval(prior, grade);
    const passed = isPass(grade);

    applyReviewToCard(
      this,
      card.id,
      updated,
      dueTimestamp(updated.intervalDays, now, this.secondsPerDay),
      now,
      !passed,
    );
    insertReview(this, {
      card_id: card.id,
      grade,
      user_answer: answer,
      feedback,
      reviewed_at: now,
    });
    touchStreak(this, now, this.msPerDay);
    insertMessage(this, "assistant", feedback, now);

    this.emit({
      type: "review_result",
      cardId: card.id,
      grade,
      passed,
      feedback,
      correctAnswer: card.answer,
      nextDueInDays: updated.intervalDays,
    });

    this.setState({ ...this.state, activeReview: null, thinking: false });
    this.refreshState();
    await this.scheduleNextReview();
  }

  /**
   * Ask the model how well the learner recalled the card.
   *
   * Uses `generateText` with a line-oriented contract rather than structured
   * output — see `grading.ts` for why. A failure here falls back to a neutral
   * passing grade so a model hiccup never destroys a repetition chain.
   */
  private async gradeAnswer(
    card: CardRow,
    answer: string,
    revealed: boolean,
  ): Promise<{ grade: 0 | 1 | 2 | 3 | 4 | 5; feedback: string }> {
    // If they asked to see the answer before attempting it, that is a lapse by
    // definition — no point spending a model call to confirm it.
    if (revealed) {
      return {
        grade: 0,
        feedback: "You looked this one up, so I'll bring it back around soon.",
      };
    }

    try {
      const { text } = await generateText({
        model: chatModel(this.env, this.sessionAffinity),
        system: `You grade a learner's attempt to recall a flashcard. Judge the substance of what they said, not its wording or completeness of phrasing. Be fair but not generous: a vague gesture at the right idea is a 3, not a 5.\n\n${GRADE_FORMAT_INSTRUCTION}`,
        prompt: `Question: ${card.question}\nCorrect answer: ${card.answer}\nLearner's answer: ${answer}`,
      });
      return parseGradeResponse(text);
    } catch (error) {
      console.error("grading failed", error);
      return {
        grade: 3,
        feedback: "I couldn't check that properly — I'll show it again shortly.",
      };
    }
  }

  private revealAnswer(): void {
    const active = this.state.activeReview;
    if (!active) return;

    const card = getCard(this, active.cardId);
    if (!card) return;

    this.setState({
      ...this.state,
      activeReview: { ...active, revealed: true },
    });
    this.emit({ type: "token", id: crypto.randomUUID(), delta: "" });
    this.emit({
      type: "review_result",
      cardId: card.id,
      grade: 0,
      passed: false,
      feedback: "Here's the answer — have a go at saying it back in your own words.",
      correctAnswer: card.answer,
      nextDueInDays: 1,
    });
  }

  private async skipReview(): Promise<void> {
    const active = this.state.activeReview;
    if (!active) return;

    // Skipping is not failing. Push the card out by one interval-day and move
    // on, leaving its ease and repetition chain untouched.
    const card = getCard(this, active.cardId);
    if (card) {
      const now = Date.now();
      applyReviewToCard(
        this,
        card.id,
        {
          ease: card.ease,
          intervalDays: card.interval_days,
          repetitions: card.repetitions,
        },
        dueTimestamp(1, now, this.secondsPerDay),
        card.last_reviewed_at ?? now,
        false,
      );
    }

    this.setState({ ...this.state, activeReview: null });
    this.refreshState();
    await this.scheduleNextReview();
  }

  /**
   * Point the alarm at whichever card comes due first.
   *
   * Existing review schedules are cancelled before a new one is set, otherwise
   * every save and every graded answer would stack another alarm and the
   * learner would get quizzed in bursts.
   */
  private async scheduleNextReview(): Promise<void> {
    await this.clearReviewSchedules();
    if (this.state.activeReview) return;

    const rows = this.sql<{ t: number | null }>`SELECT MIN(due_at) AS t FROM cards`;
    const nextDue = rows[0]?.t;
    if (nextDue == null) return;

    const delaySeconds = Math.max(
      5,
      Math.ceil((nextDue - Date.now()) / 1000),
    );
    await this.schedule(delaySeconds, REVIEW_CALLBACK);
  }

  private async clearReviewSchedules(): Promise<void> {
    const schedules = await this.listSchedules();
    for (const schedule of schedules) {
      if (schedule.callback === REVIEW_CALLBACK) {
        await this.cancelSchedule(schedule.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // ToolHost — what the model is allowed to do
  // -------------------------------------------------------------------------

  /**
   * Persist cards, skipping semantic duplicates.
   *
   * @returns how many were actually new.
   */
  async saveCards(
    deck: string,
    cards: { question: string; answer: string }[],
    source: "chat" | "deck",
  ): Promise<number> {
    if (cards.length === 0) return 0;

    const duplicates = await flagDuplicates(this.env, this.instanceName, cards);
    const now = Date.now();
    const saved: CardRow[] = [];

    for (const [i, card] of cards.entries()) {
      if (duplicates[i]) continue;
      const id = insertCard(
        this,
        { deck, question: card.question, answer: card.answer, source },
        now,
      );
      if (!id) continue;
      const row = getCard(this, id);
      if (row) saved.push(row);
    }

    if (saved.length > 0) {
      await indexCards(this.env, this.instanceName, saved);
      this.refreshState();
      // New cards are due immediately, so nudge the first quiz out a little —
      // being tested one second after being taught is not spaced repetition.
      await this.deferFirstReview(saved, now);
    }

    return saved.length;
  }

  /** Give freshly-taught cards a grace period before their first quiz. */
  private async deferFirstReview(saved: CardRow[], now: number): Promise<void> {
    const dueAt = now + this.firstReviewDelay * 1000;
    for (const card of saved) {
      this.sql`UPDATE cards SET due_at = ${dueAt} WHERE id = ${card.id}`;
    }
    await this.scheduleNextReview();
  }

  /** Entry point the DeckBuilder workflow calls back into over RPC. */
  async saveDeckCards(
    deck: string,
    cards: { question: string; answer: string }[],
  ): Promise<number> {
    return this.saveCards(deck, cards, "deck");
  }

  async startDeckBuild(topic: string, cardCount: number): Promise<string> {
    const workflowId = await this.runWorkflow("DECK_BUILDER", {
      topic,
      cardCount,
    });

    this.setState({
      ...this.state,
      workflow: {
        id: workflowId,
        topic,
        label: "Planning the deck",
        done: 0,
        total: 1,
        status: "running",
      },
    });

    return workflowId;
  }

  async beginReview(): Promise<boolean> {
    if (this.state.activeReview) return true;
    if (countDue(this, Date.now()) === 0) return false;
    await this.runReview();
    return this.state.activeReview !== null;
  }

  async searchMemory(query: string) {
    const hits = await recall(this.env, this, this.instanceName, query, 5);
    return hits.map((h) => ({
      deck: h.deck,
      question: h.question,
      answer: h.answer,
      score: h.score,
    }));
  }

  progressReport() {
    const now = Date.now();
    return {
      cardCount: countCards(this),
      dueCount: countDue(this, now),
      mastery: overallMastery(this),
      streakDays: currentStreak(this),
      reviewsCompleted: countReviews(this),
      decks: deckRollups(this, now),
    };
  }

  announceTool(name: string, label: string): void {
    this.emit({ type: "tool", id: crypto.randomUUID(), name, label });
  }

  // -------------------------------------------------------------------------
  // Workflow callbacks
  // -------------------------------------------------------------------------

  async onWorkflowProgress(
    _workflowName: string,
    workflowId: string,
    progress: unknown,
  ): Promise<void> {
    const p = progress as { step?: string; done?: number; total?: number };
    const current = this.state.workflow;

    this.setState({
      ...this.state,
      workflow: {
        id: workflowId,
        topic: current?.topic ?? "",
        label: p.step ?? current?.label ?? "Working",
        done: p.done ?? current?.done ?? 0,
        total: p.total ?? current?.total ?? 1,
        status: "running",
      },
    });
  }

  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: unknown,
  ): Promise<void> {
    const summary = result as { saved?: number; skipped?: number } | undefined;
    const current = this.state.workflow;

    this.setState({
      ...this.state,
      workflow: {
        id: workflowId,
        topic: current?.topic ?? "",
        label:
          summary?.saved != null
            ? `Added ${summary.saved} cards` +
              (summary.skipped ? ` (${summary.skipped} duplicates skipped)` : "")
            : "Deck ready",
        done: current?.total ?? 1,
        total: current?.total ?? 1,
        status: "complete",
      },
    });

    this.refreshState();
    await this.scheduleNextReview();
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    console.error("deck workflow failed", error);
    const current = this.state.workflow;
    this.setState({
      ...this.state,
      workflow: {
        id: workflowId,
        topic: current?.topic ?? "",
        label: "Deck build failed",
        done: current?.done ?? 0,
        total: current?.total ?? 1,
        status: "error",
      },
    });
  }

  // -------------------------------------------------------------------------
  // State + helpers
  // -------------------------------------------------------------------------

  /** Recompute every derived counter and push it to connected clients. */
  private refreshState(): void {
    const now = Date.now();
    this.setState({
      ...this.state,
      cardCount: countCards(this),
      dueCount: countDue(this, now),
      decks: deckRollups(this, now),
      mastery: overallMastery(this),
      streakDays: currentStreak(this),
      reviewsCompleted: countReviews(this),
      memoryMode: memoryMode(this.env),
    });
  }

  private transcript(): ChatMessage[] {
    return recentMessages(this, 100).map((row) => ({
      id: row.id,
      role: row.role as ChatMessage["role"],
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  private async resetEverything(): Promise<void> {
    await this.clearReviewSchedules();

    const ids = listCards(this, undefined, 1000).map((c) => c.id);
    if (ids.length > 0 && memoryMode(this.env) === "vector") {
      try {
        await this.env.MEMORY_INDEX.deleteByIds(ids);
      } catch (error) {
        // A stranded vector is harmless — it can never be returned, because
        // recall only ever surfaces cards that still exist in SQLite.
        console.error("vector cleanup failed", error);
      }
    }

    this.sql`DELETE FROM cards`;
    this.sql`DELETE FROM reviews`;
    this.sql`DELETE FROM messages`;
    this.sql`DELETE FROM profile`;

    this.setState({ ...INITIAL_COACH_STATE, memoryMode: memoryMode(this.env) });
    this.emit({ type: "history", messages: [] });
  }

  private emit(message: ServerMessage): void {
    this.broadcast(JSON.stringify(message));
  }

  private sendTo(connection: Connection, message: ServerMessage): void {
    connection.send(JSON.stringify(message));
  }
}

function numberFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
