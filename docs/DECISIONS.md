# Decisions

The choices that shaped this build, and what each one cost.

---

## 1. Workers AI, not NVIDIA NIM or another external LLM

**Context.** The assignment recommends Llama 3.3 on Workers AI but explicitly permits "an
external LLM of your choice". NVIDIA NIM was considered seriously.

**Decision.** Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

**Why.**

- **The agent loop needs streaming *and* function calling.** Several Workers AI text
  models offer one or the other; this one does both, which is a hard requirement here.
- **No API key.** It's a binding, not an HTTP credential. `npm install && wrangler dev`
  and the project runs. An external provider would put an account signup between a
  reviewer and a working demo.
- **NIM is not an AI Gateway provider.** The supported list covers Workers AI, Bedrock,
  Anthropic, Azure OpenAI, Groq, Mistral, OpenAI, xAI and about fifteen others — NVIDIA is
  not among them. Routing NIM through the gateway for caching, unified logs and analytics
  was therefore not possible, which removed most of the argument for using it.
- **Latency.** A binding call stays inside Cloudflare's network. An external provider adds
  egress on every turn, and this app makes several model calls per interaction.

**Cost.** Llama 3.3's 24k context window is the tightest constraint in the project, and it
directly shaped the memory design (see §5). Its tool-calling is good but not frontier, so
tools are kept few and flat and nothing correctness-critical depends on them (§3).

**Reversal.** `src/server/model.ts` is the only file naming a model. NIM is
OpenAI-compatible at `https://integrate.api.nvidia.com/v1`, so switching is a change to
one function, not a refactor.

---

## 2. One Durable Object per learner

**Context.** The conventional shape would be a stateless Worker plus D1 or an external
database.

**Decision.** Each learner is a `StudyCoach` Durable Object instance holding their own
SQLite database.

**Why.** Three things collapse into one primitive:

- **Isolation becomes structural.** There is no `user_id` column anywhere in the schema,
  because there is nothing to disambiguate. A query bug cannot leak another learner's
  cards; there are no other learners in that database.
- **The agent gets its own clock.** `this.schedule()` sets a Durable Object alarm. Without
  it, unprompted reviews would need a cron Worker scanning a due-cards table across all
  users, plus a way to reach the right open WebSocket.
- **State sync comes free.** `setState()` persists and broadcasts. The sidebar contains no
  fetch calls.

**Cost.** Cross-learner queries ("which cards do most people find hard?") would need a
separate aggregation path. Nothing in this product wants that.

---

## 3. Grading is routed in code, not exposed as a tool

**Context.** Everything else the agent does is a tool call. Grading could have been
`grade_answer({card_id, grade, feedback})`.

**Decision.** When `state.activeReview` is set, the next message is intercepted before the
chat path and graded by a dedicated call. The model never sees it as conversation.

**Why.** A tool call is a *probabilistic* branch. When the model forgot to call it, the
answer would be treated as ordinary chat, the review would never close, and the card's
schedule would silently stall. Routing on state makes the path unconditional.

The general rule, applied throughout: **a tool may be missed, so nothing whose absence
corrupts data may be a tool.** Saving cards is a fine tool — forgetting costs one turn's
cards. Grading is not.

**Cost.** One fewer thing the model controls, and a branch in `handleUserText` that must
be kept correct.

---

## 4. Line-oriented parsing, not JSON mode

**Context.** Three places need structure out of the model: grades, subtopic outlines, and
flashcards. The AI SDK offers `generateObject` with a Zod schema.

**Decision.** Ask for labelled lines (`GRADE:`, `Q:` / `A:`) and parse with regex.

**Why.** Structured output on mid-sized open models fails in ways that are awkward to
recover from: truncated objects, schema drift, prose wrapped around the JSON. The failure
granularity is the problem — one malformed JSON object loses an entire batch of twenty
cards, whereas one malformed line loses one card.

It also degrades predictably. `parseGradeResponse` falls back to grade 3 — the lowest
passing grade — because a parse failure is a bug in *this* code and recording it as a lapse
would destroy a repetition chain the learner earned.

All three parsers are pure functions with 28 unit tests between them.

**Cost.** Hand-written parsers instead of a schema. Cheap, and the tests make the
behaviour explicit rather than implicit in a library.

---

## 5. Three memory layers instead of one

**Context.** A 24k context window and a product whose entire premise is remembering.

**Decision.** SQLite as the source of truth, Vectorize for semantic recall and
deduplication, and a rolling LLM summary for long-conversation continuity.

**Why each exists.**

- **SQLite** — complete, never lossy, per-learner, zero-latency.
- **Vectorize** — keyword search cannot answer "what do I know about consistency?" with
  cards about the CAP theorem that never use the word. It also catches near-duplicate
  cards: a model asked for cards on eight subtopics produces the same fact three times in
  different words, and `LIKE` catches none of it. Threshold 0.92 cosine, tuned by hand —
  lower values started discarding good cards.
- **Rolling summary** — the transcript will outgrow 24k tokens. The model sees stable
  summarised notes plus the last ~12 turns verbatim, trimmed from the newest end backwards
  so the most recent turn is never the one dropped.

Ordering is deliberate: notes first, then the verbatim tail, so the prompt prefix stays
stable and the KV prefix cache can hit across turns. The system prompt is static for the
same reason.

**Cost.** Three layers to keep coherent, and Vectorize needs provisioning. Mitigated by
`MEMORY_MODE="sql"`, which disables the vector layer and keeps everything else working.

---

## 6. Deck building is a Workflow, not a loop in the agent

**Context.** "Build me a deck on X" is a dozen sequential inference calls.

**Decision.** A Cloudflare Workflow (`DeckBuilder extends AgentWorkflow`), one `step.do`
per subtopic.

**Why.** Written as a loop inside the agent, a failure on the eleventh call loses the
first ten, and an eviction mid-run loses everything. As a Workflow each step retries
independently, the run survives eviction, and `reportProgress` gives the UI a real
progress bar instead of a spinner. A subtopic that fails permanently is skipped rather
than failing the deck.

Cards are written back **through the agent** by RPC rather than straight to storage, so
deduplication, vector indexing and schedule updates stay in one code path shared with
conversationally-mined cards.

**Cost.** A second deployable class and an RPC hop.

---

## 7. Vanilla HTML and TypeScript, no framework

**Context.** The starter template is React. The brief asked for an HTML file.

**Decision.** One `index.html`, ~300 lines of TypeScript, no framework. Vite bundles it so
it can use the official `AgentClient`.

**Why.** The UI is a transcript and a sidebar. The transcript is append-only and driven by
events; the sidebar is a pure function of synced state and is replaced wholesale. Neither
wants reconciliation. Shipping React to render that is weight without benefit — the bundle
is 86 kB, 26 kB gzipped, nearly all of it the SDK client.

**Cost.** Manual DOM work. It stayed manageable at this size; it would not at three times
the size.

**The tradeoff taken.** A literal reading of "an HTML file" would mean no build step at
all, hand-rolling the WebSocket protocol in one unbundled file. That works, but it
hard-codes SDK internals that could shift. The supported client API was worth the bundler.

---

## 8. A compressed demo clock

**Context.** SM-2's first intervals are 1 day and 6 days. A reviewer has two minutes.

**Decision.** `SECONDS_PER_DAY` (default 30) scales SM-2 days to wall-clock time at the
scheduling boundary. `86400` gives real behaviour.

**Why.** Without it the headline feature — the agent waking itself up to quiz you — is
undemonstrable without returning tomorrow. The alternative, faking short intervals inside
the algorithm, would mean the thing being demonstrated isn't the thing that ships.

**Why it's honest.** The scaling lives in exactly one function, `dueTimestamp`, at the
point where an abstract interval becomes a timestamp. `sm2.ts` has no concept of seconds
and its tests assert real day-scale intervals. The README and the UI both say the clock is
compressed.

**Cost.** A reviewer who misses the note might think intervals are wrong. Flagged in three
places to make that unlikely.
