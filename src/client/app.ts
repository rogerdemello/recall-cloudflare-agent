/**
 * Browser client.
 *
 * Two channels carry everything:
 *
 *  - **Synced state.** `CoachState` arrives through the Agents SDK's own state
 *    replication — counts, mastery, streak, the active review, workflow
 *    progress, and the timestamp of the next scheduled quiz. The whole right
 *    panel is a pure function of it. Nothing here polls.
 *  - **Events.** Token deltas, agent activity and review results come over the
 *    same socket as explicit messages, because a stream of tokens is not state.
 *
 * The one thing the interface adds on top is a local clock. `nextReviewAt` is a
 * timestamp; turning it into a visible countdown is what makes the agent's most
 * surprising behaviour — waking itself up — legible before it happens, instead
 * of a surprise nobody stays long enough to see.
 *
 * Deliberately no framework. The thread is append-only and event-driven; the
 * panel is a pure render of state. Neither wants reconciliation.
 */

import { AgentClient } from "agents/client";
import type {
  CardView,
  ChatMessage,
  ClientMessage,
  CoachState,
  ServerMessage,
} from "../shared/protocol";
import { VoiceRecorder } from "./voice";

// ──────────────────────────────────────────────────────────────── elements

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const app = el("app");
const thread = el("thread");
const welcome = el("welcome");
const input = el<HTMLTextAreaElement>("input");
const sendBtn = el<HTMLButtonElement>("send");
const micBtn = el<HTMLButtonElement>("mic");
const hint = el("hint");
const status = el("status");
const memoryChip = el("memory-chip");
const answerDeck = el("answer-deck");
const drawer = el("drawer");
const scrim = el("scrim");

// ──────────────────────────────────────────────────────────────── identity

/**
 * Which agent instance to talk to.
 *
 * `?learner=` wins so two tabs can hold genuinely separate learners — useful
 * for showing that each gets its own isolated Durable Object. Otherwise a
 * stable id lives in localStorage, so a reload returns to the same learner,
 * which is rather the point of a memory demo.
 */
function learnerId(): string {
  const fromUrl = new URLSearchParams(location.search).get("learner");
  if (fromUrl) {
    const clean = sanitise(fromUrl);
    if (clean) {
      localStorage.setItem("recall:learner", clean);
      return clean;
    }
  }
  const stored = localStorage.getItem("recall:learner");
  if (stored) return stored;

  const fresh = `learner-${Math.random().toString(36).slice(2, 9)}`;
  localStorage.setItem("recall:learner", fresh);
  return fresh;
}

const sanitise = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

// ─────────────────────────────────────────────────────────────────── theme

type Theme = "dark" | "light";

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("recall:theme", theme);
}

const storedTheme = localStorage.getItem("recall:theme") as Theme | null;
if (storedTheme) applyTheme(storedTheme);

el("theme").addEventListener("click", () => {
  const current =
    (document.documentElement.dataset.theme as Theme | undefined) ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(current === "dark" ? "light" : "dark");
});

// ────────────────────────────────────────────────────────────── connection

let state: CoachState | null = null;

const client = new AgentClient<unknown, CoachState>({
  // Kebab-case of the `StudyCoach` Durable Object binding — what
  // `routeAgentRequest` matches on the server.
  agent: "study-coach",
  name: learnerId(),
  host: location.host,
  onStateUpdate: (next) => {
    state = next;
    renderPanel(next);
    renderReviewMode(next);
  },
});

client.addEventListener("open", () => setStatus("connected", "up"));
client.addEventListener("close", () => setStatus("reconnecting", "down"));
client.addEventListener("error", () => setStatus("offline", "down"));

client.addEventListener("message", (event: MessageEvent) => {
  if (typeof event.data !== "string") return;
  let message: ServerMessage;
  try {
    message = JSON.parse(event.data) as ServerMessage;
  } catch {
    return;
  }
  // The SDK multiplexes its own state frames here; those are handled by
  // onStateUpdate and carry types outside our union.
  if (!message || typeof message.type !== "string") return;
  handle(message);
});

function send(message: ClientMessage): void {
  client.send(JSON.stringify(message));
}

// ───────────────────────────────────────────────────────────── event stream

/** Open assistant bubbles, keyed by turn id, while tokens still arrive. */
const streaming = new Map<string, HTMLElement>();

function handle(message: ServerMessage): void {
  switch (message.type) {
    case "history":
      renderHistory(message.messages);
      break;

    case "start":
      streaming.set(message.id, bubble("assistant", ""));
      break;

    case "token": {
      if (!message.delta) break;
      const node = streaming.get(message.id) ?? bubble("assistant", "");
      streaming.set(message.id, node);
      node.textContent = (node.textContent ?? "") + message.delta;
      toEnd();
      break;
    }

    case "done": {
      const node = streaming.get(message.id);
      if (node) node.textContent = message.content;
      streaming.delete(message.id);
      break;
    }

    case "tool":
      trace(message.label);
      logLine(message.label, true);
      break;

    case "review_start":
      quizCard(message.question, message.deck);
      logLine(`asked about "${truncate(message.question, 34)}"`, true);
      input.placeholder = "Say what you remember…";
      input.focus();
      break;

    case "review_result":
      resultCard(message);
      logLine(`graded ${message.grade}/5 · next in ${days(message.nextDueInDays)}`);
      input.placeholder = "Ask me to teach you something…";
      break;

    case "review_none":
      setHint("Nothing is due yet — I'll come to you.");
      break;

    case "cards":
      renderDrawer(message.deck, message.cards);
      break;

    case "error":
      setHint(message.message);
      break;
  }
}

// ───────────────────────────────────────────────────────────────── thread

function renderHistory(messages: ChatMessage[]): void {
  thread.replaceChildren();
  streaming.clear();

  if (messages.length === 0) {
    thread.appendChild(welcome);
    return;
  }
  for (const message of messages) {
    if (message.role === "system") continue;
    bubble(message.role, message.content);
  }
  toEnd();
}

function bubble(role: "user" | "assistant", text: string): HTMLElement {
  welcome.remove();
  const node = document.createElement("div");
  node.className = `msg ${role}`;
  node.textContent = text;
  thread.appendChild(node);
  toEnd();
  return node;
}

/** A one-line note in the thread about what the agent just did. */
function trace(label: string): void {
  welcome.remove();
  const node = document.createElement("div");
  node.className = "trace";
  node.textContent = label;
  thread.appendChild(node);
  toEnd();
}

function quizCard(question: string, deck: string): void {
  welcome.remove();
  const node = document.createElement("div");
  node.className = "quiz";

  const head = document.createElement("div");
  head.className = "quiz-head";

  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Your turn";

  const deckName = document.createElement("span");
  deckName.className = "deck";
  deckName.textContent = deck;

  head.append(eyebrow, deckName);

  const q = document.createElement("q");
  q.textContent = question;

  node.append(head, q);
  thread.appendChild(node);
  toEnd();
}

function resultCard(
  result: Extract<ServerMessage, { type: "review_result" }>,
): void {
  welcome.remove();
  const node = document.createElement("div");
  node.className = `result ${result.passed ? "pass" : "fail"}`;

  const top = document.createElement("div");
  top.className = "result-top";

  const pips = document.createElement("div");
  pips.className = "pips";
  for (let i = 0; i < 5; i++) {
    const pip = document.createElement("i");
    if (i < result.grade) pip.className = "on";
    pips.appendChild(pip);
  }

  const verdict = document.createElement("span");
  verdict.className = "verdict";
  verdict.textContent = result.passed ? "recalled" : "missed";

  const next = document.createElement("span");
  next.className = "next";
  next.textContent = `back in ${days(result.nextDueInDays)}`;

  top.append(pips, verdict, next);

  const feedback = document.createElement("div");
  feedback.textContent = result.feedback;

  node.append(top, feedback);

  if (!result.passed && result.correctAnswer) {
    const answer = document.createElement("div");
    answer.className = "answer";
    const label = document.createElement("b");
    label.textContent = "The answer: ";
    answer.append(label, document.createTextNode(result.correctAnswer));
    node.appendChild(answer);
  }

  thread.appendChild(node);
  toEnd();
}

const toEnd = (): void => {
  thread.scrollTop = thread.scrollHeight;
};

// ──────────────────────────────────────────────────────────── synced panel

function renderPanel(next: CoachState): void {
  el("s-cards").textContent = String(next.cardCount);
  el("s-due").textContent = String(next.dueCount);
  el("s-reviews").textContent = String(next.reviewsCompleted);
  el("s-streak").textContent = String(next.streakDays);
  el("stat-due").dataset.zero = String(next.dueCount === 0);

  const pct = Math.round(next.mastery * 100);
  el("mastery-bar").style.width = `${pct}%`;
  el("mastery-pct").textContent = `${pct}%`;

  memoryChip.textContent =
    next.memoryMode === "vector" ? "semantic memory" : "keyword memory";

  renderClock(next);
  renderDecks(next);
  renderWorkflow(next);
  renderClockScale(next);

  // The composer locks while the model is mid-turn, but never during a review —
  // answering is exactly what should happen next.
  const busy = next.thinking && !next.activeReview;
  sendBtn.disabled = busy;
  input.disabled = busy;
  if (busy) setHint("Thinking…");
  else if (hint.textContent === "Thinking…") setHint("");
}

/**
 * The countdown.
 *
 * `nextReviewAt` is a timestamp from the server; the span it's counting down
 * over is captured the first time we see a given target so the drain bar has a
 * denominator. State updates arrive irregularly, so the tick runs locally.
 */
let countdownTarget: number | null = null;
let countdownSpan = 1;

function renderClock(next: CoachState): void {
  const clock = el("clock");
  const label = el("clock-label");
  const time = el("clock-time");
  const drain = el("drain");
  const note = el("clock-note");

  if (next.activeReview) {
    countdownTarget = null;
    clock.className = "clock now";
    label.textContent = "Waiting on you";
    time.textContent = "Answer below";
    time.style.fontFamily = "var(--serif)";
    time.style.fontSize = "17px";
    drain.hidden = true;
    note.textContent = "Say what you remember. I grade the substance, not the wording.";
    return;
  }

  if (next.nextReviewAt == null) {
    countdownTarget = null;
    clock.className = "clock idle";
    label.textContent = "Nothing scheduled";
    time.textContent = next.cardCount
      ? "All caught up."
      : "Teach me something first.";
    time.style.fontFamily = "";
    time.style.fontSize = "";
    drain.hidden = true;
    note.textContent = next.cardCount
      ? "Every card is resting. I'll be back when one comes due."
      : "Once you do, I'll set my own alarm and come back to quiz you.";
    return;
  }

  if (countdownTarget !== next.nextReviewAt) {
    countdownTarget = next.nextReviewAt;
    countdownSpan = Math.max(1000, next.nextReviewAt - Date.now());
  }

  clock.className = "clock armed";
  label.textContent = "Next review in";
  time.style.fontFamily = "";
  time.style.fontSize = "";
  drain.hidden = false;
  note.textContent = "I wake myself up for this. You can close the tab.";
  tick();
}

function tick(): void {
  if (countdownTarget === null) return;

  const remaining = countdownTarget - Date.now();
  const time = el("clock-time");
  const clock = el("clock");
  const bar = el("drain").firstElementChild as HTMLElement | null;

  if (remaining <= 0) {
    time.textContent = "any moment";
    clock.className = "clock now";
    el("clock-label").textContent = "Due";
    if (bar) bar.style.width = "0%";
    return;
  }

  const total = Math.ceil(remaining / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  time.textContent = `${mins}:${String(secs).padStart(2, "0")}`;
  if (bar) bar.style.width = `${Math.max(0, (remaining / countdownSpan) * 100)}%`;
}

setInterval(tick, 1000);

function renderClockScale(next: CoachState): void {
  const node = el("clock-scale");
  if (next.secondsPerDay >= 86400) {
    node.textContent = "Intervals run in real days.";
    return;
  }
  // Be honest about the compressed demo clock rather than showing intervals
  // that quietly don't mean what they say.
  node.textContent = `Demo clock: one SM-2 “day” passes every ${next.secondsPerDay}s, so you can watch intervals grow. The algorithm is untouched.`;
}

function renderDecks(next: CoachState): void {
  const host = el("decks");

  if (next.decks.length === 0) {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "Nothing yet — they appear as we talk.";
    host.replaceChildren(note);
    return;
  }

  const list = document.createElement("div");
  list.className = "decks";

  for (const deck of next.decks) {
    const row = document.createElement("button");
    row.className = "deck-row";
    row.title = `Browse "${deck.deck}"`;

    const name = document.createElement("span");
    name.className = "nm";
    name.textContent = deck.deck;

    const count = document.createElement("span");
    count.className = "ct";
    count.textContent = String(deck.cardCount);

    row.append(name, count);

    if (deck.dueCount > 0) {
      const due = document.createElement("span");
      due.className = "pill";
      due.textContent = `${deck.dueCount} due`;
      row.appendChild(due);
    }

    row.addEventListener("click", () => openDeck(deck.deck));
    list.appendChild(row);
  }

  host.replaceChildren(list);
}

function renderWorkflow(next: CoachState): void {
  const section = el("wf-section");
  const box = el("wf");

  if (!next.workflow) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  el("wf-label").textContent = next.workflow.label;

  const pct = next.workflow.total
    ? Math.round((next.workflow.done / next.workflow.total) * 100)
    : 0;
  el("wf-bar").style.width = `${pct}%`;

  box.className = "wf";
  if (next.workflow.status === "complete") box.classList.add("done");
  if (next.workflow.status === "error") box.classList.add("error");

  if (lastWorkflowLabel !== next.workflow.label) {
    lastWorkflowLabel = next.workflow.label;
    logLine(next.workflow.label);
  }
}

let lastWorkflowLabel = "";

function renderReviewMode(next: CoachState): void {
  const reviewing = next.activeReview !== null;
  app.classList.toggle("reviewing", reviewing);
  answerDeck.textContent = next.activeReview?.deck ?? "";
  if (reviewing) input.placeholder = "Say what you remember…";
}

// ───────────────────────────────────────────────────────────── activity log

/**
 * A running account of what the agent is doing.
 *
 * Most of this machinery is invisible — a tool call, a background extraction,
 * a workflow step. Surfacing it is the difference between "it replied" and
 * "I can see what it's actually doing".
 */
function logLine(text: string, highlight = false): void {
  const host = el("log");
  host.querySelector(".empty-note")?.remove();

  const row = document.createElement("div");
  row.className = `log-row${highlight ? " hi" : ""}`;

  const time = document.createElement("time");
  const now = new Date();
  time.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

  const what = document.createElement("span");
  what.textContent = text;

  row.append(time, what);
  host.prepend(row);

  while (host.children.length > 40) host.lastElementChild?.remove();
}

// ───────────────────────────────────────────────────────────── deck drawer

function openDeck(deck: string): void {
  el("drawer-title").textContent = deck;
  el("drawer-body").replaceChildren(loadingNote());
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  scrim.classList.add("open");
  send({ type: "cards", deck });
}

function closeDeck(): void {
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  scrim.classList.remove("open");
}

scrim.addEventListener("click", closeDeck);
el("drawer-close").addEventListener("click", closeDeck);
addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDeck();
});

function loadingNote(): HTMLElement {
  const p = document.createElement("p");
  p.className = "empty-note";
  p.textContent = "Loading…";
  return p;
}

function renderDrawer(deck: string | null, cards: CardView[]): void {
  const body = el("drawer-body");

  if (cards.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "No cards in this deck yet.";
    body.replaceChildren(p);
    return;
  }

  body.replaceChildren(
    ...cards.map((card) => {
      const node = document.createElement("div");
      node.className = "card";

      const q = document.createElement("div");
      q.className = "q";
      q.textContent = card.question;

      const a = document.createElement("div");
      a.className = "a";
      a.textContent = card.answer;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.append(stageTag(card), metaText(card));

      node.append(q, a, meta);
      return node;
    }),
  );
}

/** Card stage, encoded as form and colour rather than a bare number. */
function stageTag(card: CardView): HTMLElement {
  const tag = document.createElement("span");
  tag.className = "tag";

  if (card.dueAt <= Date.now()) {
    tag.classList.add("due");
    tag.textContent = "due";
  } else if (card.intervalDays <= 0) {
    tag.classList.add("new");
    tag.textContent = "unseen";
  } else if (card.intervalDays >= 21) {
    tag.classList.add("mature");
    tag.textContent = "learned";
  } else {
    tag.classList.add("learning");
    tag.textContent = "learning";
  }
  return tag;
}

function metaText(card: CardView): HTMLElement {
  const span = document.createElement("span");
  const bits: string[] = [];

  // A card with no interval has never been recalled, so "interval moments"
  // would be nonsense. Say what's actually true about it instead.
  bits.push(
    card.intervalDays > 0
      ? `interval ${days(card.intervalDays)}`
      : "awaiting first review",
  );

  if (card.repetitions > 0) bits.push(`${card.repetitions}× recalled`);
  if (card.lapses > 0) bits.push(`${card.lapses} lapse${card.lapses > 1 ? "s" : ""}`);

  span.textContent = bits.join(" · ");
  return span;
}

// ────────────────────────────────────────────────────────────────── compose

function submit(): void {
  const text = input.value.trim();
  if (!text) return;

  bubble("user", text);
  send({ type: "chat", id: crypto.randomUUID(), text });

  input.value = "";
  resize();
  setHint("");
}

sendBtn.addEventListener("click", submit);

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

input.addEventListener("input", resize);

function resize(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 170)}px`;
}

for (const button of document.querySelectorAll<HTMLButtonElement>(
  ".starters button",
)) {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt ?? "";
    submit();
  });
}

// ─────────────────────────────────────────────────────────── review actions

el("reveal").addEventListener("click", () => send({ type: "reveal_answer" }));
el("skip").addEventListener("click", () => send({ type: "skip_review" }));

el("reset").addEventListener("click", () => {
  if (!confirm("Delete every card, review and message for this learner?")) return;
  send({ type: "reset" });
  el("log").replaceChildren();
  logLine("reset everything");
  setHint("Starting fresh.");
});

// ─────────────────────────────────────────────────────────────────── voice

const recorder = new VoiceRecorder({
  onStateChange: (recording) => {
    micBtn.classList.toggle("rec", recording);
    micBtn.textContent = recording ? "■" : "●";
    micBtn.title = recording ? "Stop" : "Speak";
    setHint(recording ? "Listening — click again when you're done." : "");
  },
  onTranscript: (text) => {
    input.value = text;
    resize();
    submit();
  },
  onError: (message) => setHint(message),
});

if (!VoiceRecorder.isSupported()) {
  micBtn.disabled = true;
  micBtn.title = "This browser can't record audio";
} else {
  micBtn.addEventListener("click", () => void recorder.toggle());
}

// ───────────────────────────────────────────────────────────────── helpers

function setStatus(text: string, kind: "up" | "down"): void {
  status.className = `chip ${kind}`;
  status.replaceChildren();
  const led = document.createElement("i");
  led.className = "led";
  status.append(led, document.createTextNode(text));
}

function setHint(text: string): void {
  hint.textContent = text;
}

/** Intervals are SM-2 "days", which the server may be running compressed. */
function days(value: number): string {
  if (value < 1) return "moments";
  if (value === 1) return "1 day";
  if (value < 30) return `${Math.round(value)} days`;
  return `${(value / 30).toFixed(1)} months`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ───────────────────────────────────────────────────────────────────── init

resize();
input.focus();
