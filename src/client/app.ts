/**
 * Browser client.
 *
 * Two channels carry everything:
 *
 *  - **Synced state.** `CoachState` arrives through the Agents SDK's own state
 *    replication — card counts, mastery, streak, the active review, workflow
 *    progress. The sidebar is a pure function of it. Nothing here polls.
 *  - **Events.** Token deltas, tool activity and review results come over the
 *    same socket as explicit messages, because a stream of tokens is not state.
 *
 * Deliberately no framework. The UI is small enough that a handful of render
 * functions over `CoachState` is clearer than a component tree, and it keeps
 * the deployed bundle to the SDK client plus a few kilobytes.
 */

import { AgentClient } from "agents/client";
import type {
  ChatMessage,
  ClientMessage,
  CoachState,
  ServerMessage,
} from "../shared/protocol";
import { VoiceRecorder } from "./voice";

// ---------------------------------------------------------------- elements

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const app = el("app");
const chat = el("chat");
const empty = el("empty");
const input = el<HTMLTextAreaElement>("input");
const sendBtn = el<HTMLButtonElement>("send");
const micBtn = el<HTMLButtonElement>("mic");
const hint = el("hint");
const status = el("status");
const memoryBadge = el("memory-badge");
const reviewDeck = el("review-deck");

// ------------------------------------------------------------- identity

/**
 * Which agent instance to talk to.
 *
 * `?learner=` wins so two browser tabs can hold genuinely separate learners —
 * useful for showing that each gets its own isolated Durable Object and its own
 * cards. Otherwise a stable id is kept in localStorage so a reload returns to
 * the same learner, which is the whole point of a memory demo.
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

function sanitise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// -------------------------------------------------------------- connection

const client = new AgentClient<unknown, CoachState>({
  // Kebab-case of the `StudyCoach` Durable Object binding — this is the name
  // `routeAgentRequest` matches on the server.
  agent: "study-coach",
  name: learnerId(),
  // Same origin as the page: the Worker serves both the UI and the agent.
  host: location.host,
  onStateUpdate: (state) => renderState(state),
});

client.addEventListener("open", () => setStatus("connected", "live"));
client.addEventListener("close", () => setStatus("reconnecting…", "down"));
client.addEventListener("error", () => setStatus("connection error", "down"));

client.addEventListener("message", (event: MessageEvent) => {
  if (typeof event.data !== "string") return;

  let message: ServerMessage;
  try {
    message = JSON.parse(event.data) as ServerMessage;
  } catch {
    return;
  }
  // The SDK multiplexes its own state frames over this socket; they have types
  // that aren't in our union and are handled by onStateUpdate instead.
  if (!message || typeof message.type !== "string") return;

  handleServerMessage(message);
});

function send(message: ClientMessage): void {
  client.send(JSON.stringify(message));
}

// ----------------------------------------------------------- message stream

/** Open assistant bubbles, keyed by turn id, while tokens are still arriving. */
const streaming = new Map<string, HTMLElement>();

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "history":
      renderHistory(message.messages);
      break;

    case "start":
      streaming.set(message.id, addBubble("assistant", ""));
      break;

    case "token": {
      if (!message.delta) break;
      const bubble = streaming.get(message.id) ?? addBubble("assistant", "");
      streaming.set(message.id, bubble);
      bubble.textContent = (bubble.textContent ?? "") + message.delta;
      scrollToEnd();
      break;
    }

    case "done": {
      const bubble = streaming.get(message.id);
      if (bubble) bubble.textContent = message.content;
      streaming.delete(message.id);
      break;
    }

    case "tool":
      addToolChip(message.label);
      break;

    case "review_start":
      addQuiz(message.question, message.deck);
      input.placeholder = "Your answer…";
      input.focus();
      break;

    case "review_result":
      addReviewResult(message);
      input.placeholder = "Ask me to teach you something…";
      break;

    case "review_none":
      setHint("Nothing is due just yet.");
      break;

    case "error":
      setHint(message.message);
      break;
  }
}

// ---------------------------------------------------------------- rendering

function renderHistory(messages: ChatMessage[]): void {
  chat.replaceChildren();
  streaming.clear();

  if (messages.length === 0) {
    chat.appendChild(empty);
    return;
  }

  for (const message of messages) {
    if (message.role === "system") continue;
    addBubble(message.role, message.content);
  }
  scrollToEnd();
}

function addBubble(role: "user" | "assistant", text: string): HTMLElement {
  empty.remove();
  const node = document.createElement("div");
  node.className = `msg ${role}`;
  node.textContent = text;
  chat.appendChild(node);
  scrollToEnd();
  return node;
}

function addToolChip(label: string): void {
  empty.remove();
  const node = document.createElement("div");
  node.className = "tool";
  node.textContent = label;
  chat.appendChild(node);
  scrollToEnd();
}

function addQuiz(question: string, deck: string): void {
  empty.remove();
  const node = document.createElement("div");
  node.className = "msg quiz";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = deck ? `review · ${deck}` : "review";

  node.appendChild(label);
  node.appendChild(document.createTextNode(question));
  chat.appendChild(node);
  scrollToEnd();
}

function addReviewResult(
  result: Extract<ServerMessage, { type: "review_result" }>,
): void {
  empty.remove();
  const node = document.createElement("div");
  node.className = `msg result ${result.passed ? "pass" : "fail"}`;
  node.textContent = result.feedback;

  const meta = document.createElement("div");
  meta.className = "grade";
  meta.append(
    chip(`grade ${result.grade}/5`),
    chip(`next in ${formatInterval(result.nextDueInDays)}`),
  );
  node.appendChild(meta);

  if (!result.passed && result.correctAnswer) {
    const answer = document.createElement("div");
    answer.className = "answer";
    answer.textContent = result.correctAnswer;
    node.appendChild(answer);
  }

  chat.appendChild(node);
  scrollToEnd();
}

function chip(text: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

/** Intervals are in SM-2 "days", which the server may be running compressed. */
function formatInterval(days: number): string {
  if (days < 1) return "moments";
  if (days === 1) return "1 day";
  if (days < 30) return `${Math.round(days)} days`;
  return `${(days / 30).toFixed(1)} months`;
}

// ------------------------------------------------------------ synced state

function renderState(state: CoachState): void {
  el("stat-cards").textContent = String(state.cardCount);
  el("stat-due").textContent = String(state.dueCount);
  el("stat-reviews").textContent = String(state.reviewsCompleted);
  el("stat-streak").textContent = String(state.streakDays);

  const masteryPct = Math.round(state.mastery * 100);
  el("mastery-bar").style.width = `${masteryPct}%`;
  el("mastery-label").textContent = `${masteryPct}%`;

  memoryBadge.textContent =
    state.memoryMode === "vector" ? "semantic memory" : "keyword memory";

  renderDecks(state);
  renderWorkflow(state);
  renderReviewMode(state);

  // The composer is disabled while the model is mid-turn, but never while a
  // review is open — answering the question is exactly what we want next.
  const busy = state.thinking && !state.activeReview;
  sendBtn.disabled = busy;
  input.disabled = busy;
  if (busy) setHint("Thinking…");
  else if (hint.textContent === "Thinking…") setHint("");
}

function renderDecks(state: CoachState): void {
  const container = el("decks");

  if (state.decks.length === 0) {
    container.replaceChildren(note("No cards yet."));
    return;
  }

  container.replaceChildren(
    ...state.decks.map((deck) => {
      const row = document.createElement("div");
      row.className = "deck";

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = deck.deck;
      name.title = deck.deck;

      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(deck.cardCount);

      row.append(name, count);

      if (deck.dueCount > 0) {
        const due = document.createElement("span");
        due.className = "due";
        due.textContent = `${deck.dueCount} due`;
        row.appendChild(due);
      }

      return row;
    }),
  );
}

function renderWorkflow(state: CoachState): void {
  const section = el("workflow-section");
  const box = el("workflow");

  if (!state.workflow) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  el("workflow-label").textContent = state.workflow.label;

  const pct = state.workflow.total
    ? Math.round((state.workflow.done / state.workflow.total) * 100)
    : 0;
  el("workflow-bar").style.width = `${pct}%`;

  box.className = "workflow";
  if (state.workflow.status === "complete") box.classList.add("done");
  if (state.workflow.status === "error") box.classList.add("error");
}

function renderReviewMode(state: CoachState): void {
  const reviewing = state.activeReview !== null;
  app.classList.toggle("reviewing", reviewing);
  reviewDeck.textContent = state.activeReview?.deck ?? "";
  if (reviewing) input.placeholder = "Your answer…";
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "muted-note";
  p.textContent = text;
  return p;
}

function setStatus(text: string, kind: "live" | "down"): void {
  status.textContent = text;
  status.className = `badge ${kind}`;
}

function setHint(text: string): void {
  hint.textContent = text;
}

function scrollToEnd(): void {
  chat.scrollTop = chat.scrollHeight;
}

// -------------------------------------------------------------- composing

function submit(): void {
  const text = input.value.trim();
  if (!text) return;

  addBubble("user", text);
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
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

for (const button of document.querySelectorAll<HTMLButtonElement>(
  ".suggestions button",
)) {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt ?? button.textContent ?? "";
    submit();
  });
}

// ---------------------------------------------------------- review actions

el("reveal").addEventListener("click", () => send({ type: "reveal_answer" }));
el("skip").addEventListener("click", () => send({ type: "skip_review" }));

el("reset").addEventListener("click", () => {
  if (!confirm("Delete every card, review and message for this learner?")) return;
  send({ type: "reset" });
  setHint("Reset.");
});

// ------------------------------------------------------------------ voice

const recorder = new VoiceRecorder({
  onStateChange: (recording) => {
    micBtn.classList.toggle("recording", recording);
    micBtn.textContent = recording ? "⏹" : "🎙";
    setHint(recording ? "Listening… click again to stop." : "");
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
  micBtn.title = "Voice input isn't supported in this browser";
} else {
  micBtn.addEventListener("click", () => void recorder.toggle());
}

// -------------------------------------------------------------------- init

resize();
input.focus();
