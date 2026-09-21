# Architecture

## The shape of the thing

Recall is one Worker, one Durable Object class, one Workflow class and a static page.
There is no database server, no queue, no session store and no user table — those roles
are all filled by the Durable Object itself.

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser — static HTML, vanilla TS                               │
│                                                                 │
│  AgentClient ──── WebSocket ────┐    fetch ──── POST /api/transcribe
│   · sends chat / skip / reveal  │                       │        │
│   · receives token deltas       │                       │        │
│   · receives CoachState (auto)  │                       │        │
└─────────────────────────────────┼───────────────────────┼────────┘
                                  │                       │
┌─────────────────────────────────▼───────────────────────▼────────┐
│ Worker — src/server/index.ts                                     │
│   routeAgentRequest(request, env)          transcribe(...)       │
└─────────────────────────────────┬───────────────────────┬────────┘
                                  │                       │
        ┌─────────────────────────▼──────────┐            │
        │ StudyCoach — Durable Object        │            │
        │ one instance per learner           │            │
        │                                    │            │
        │  SQLite      cards, reviews,       │            │
        │              messages, profile     │            │
        │  State       synced to clients     │            │
        │  Alarm       this.schedule()       │            │
        │  Tools       4, via AI SDK         │            │
        │  Mining      post-turn extraction  │            │
        └───┬──────────────────┬─────────────┘            │
            │ runWorkflow      │ RPC (saveDeckCards)      │
            ▼                  │                          │
        ┌───────────────────┐  │                          │
        │ DeckBuilder       │──┘                          │
        │ Cloudflare        │                             │
        │ Workflow          │                             │
        └────────┬──────────┘                             │
                 │                                        │
    ┌────────────▼────────────────────────────────────────▼───────┐
    │ Workers AI                                                  │
    │   llama-3.3-70b-instruct-fp8-fast   chat · grade · generate │
    │   bge-base-en-v1.5                  embeddings              │
    │   whisper-large-v3-turbo            speech-to-text          │
    └─────────────────────────────────────────────────────────────┘
    ┌─────────────────────────────────────────────────────────────┐
    │ Vectorize — recall-memory, 768 dims, cosine                 │
    │   namespaced by learner id                                  │
    └─────────────────────────────────────────────────────────────┘
```

## Why a Durable Object per learner

The alternative — a stateless Worker plus a shared database — would need a users table, a
session mechanism, a `WHERE user_id = ?` on every query, and a separate scheduler service
to fire reviews.

With one Durable Object per learner:

- **Isolation is structural.** There is no `user_id` column anywhere in `schema.ts`,
  because there is nothing to disambiguate. A query bug cannot leak another learner's
  cards; there are no other learners in that database.
- **The agent has its own clock.** `this.schedule()` sets a Durable Object alarm. The
  object wakes, picks the most overdue card and pushes it down the socket. Nothing polls,
  and nothing needs a cron worker scanning a table of due reviews.
- **State sync comes free.** `this.setState()` persists *and* broadcasts to every
  connected client. The sidebar has no fetch calls in it at all.

## Two channels, on purpose

The browser receives two different kinds of thing, and they are carried differently.

**Synced state** — `CoachState` in `src/shared/protocol.ts`. Card counts, due count,
mastery, streak, deck rollups, the active review, workflow progress. Written with
`this.setState()`, replicated by the SDK, surfaced in the browser through
`onStateUpdate`. The whole sidebar is a pure function of this object.

It is kept deliberately small, because it is re-broadcast on every mutation. Bulk data —
the card list, the transcript, the review log — stays in SQLite and is fetched on demand.

**Events** — `ServerMessage` in the same file. Token deltas, tool-activity chips, review
questions, grade results. These are not state: a token delta is meaningless a second
later, and replaying it on reconnect would be wrong. They go over the socket as explicit
messages.

The split matters for a specific reason: streaming a reply through `setState` would
re-broadcast the entire state object on every token.

## Data model

All four tables live inside the learner's Durable Object.

```sql
cards (
  id, deck, question, answer, source,
  ease, interval_days, repetitions,     -- SM-2 scheduling state
  due_at, created_at, last_reviewed_at, lapses
)
reviews  (id, card_id, grade, user_answer, feedback, reviewed_at)
messages (id, role, content, created_at)
profile  (key, value, updated_at)       -- rolling summary, streak bookkeeping
```

`idx_cards_due` exists because due-card selection runs on every scheduler tick, not just
when someone is looking at the page.

`profile` is a small key/value side table rather than a column on a singleton row, so new
kinds of remembered fact can be added without a migration.

The Agents SDK keeps its own `cf_agents_*` tables in the same database. The names above
don't collide with them.

## Request paths

**A chat turn.** Two model calls, then a third after the reply lands. The split is forced
by a provider bug — see "Where the model is, and isn't" below.

```
browser sends {type:"chat", text}
  → agent.onMessage
  → insertMessage(user)
  → is a review open?  ── yes ─→ gradeActiveReview  (see below)
        │ no
        ▼
  ACTION PASS   generateText(ACTION_PROMPT, buildHistory(), tools, 2 steps)
      · tools execute here, where their arguments survive intact
      · each invocation → broadcast {type:"tool"}
      · prose discarded; only tool results are kept
        ▼
  REPLY PASS    streamText(SYSTEM_PROMPT, buildHistory() + findings)   no tools
      · each text delta → broadcast {type:"token"}
  → insertMessage(assistant)
        ▼
  MINING PASS   generateText(extraction prompt)      -- after the reply is delivered
      · parseCards / parseDeckName  →  saveCards()
      · dedup via Vectorize, then SQLite + vector upsert
  → maybeSummarise()          -- only if the transcript crossed a threshold
  → scheduleNextReview()      -- point the alarm at the soonest due card
```

**A scheduled review.** No browser involvement until the last line.

```
Durable Object alarm fires
  → agent.runReview()
  → dueCards(now, limit 1)          -- most overdue first
  → setState({activeReview})        -- syncs; the composer switches to answer mode
  → broadcast {type:"review_start"} -- the question appears
```

**Grading.** Routed on state, never on a tool call.

```
browser sends {type:"chat", text}   -- an answer, but it looks like any message
  → state.activeReview is set, so the chat path is skipped entirely
  → generateText(grading prompt)  →  parseGradeResponse  →  grade 0..5
  → nextInterval(prior, grade)    →  SM-2 ease / interval / repetitions
  → applyReviewToCard + insertReview + touchStreak
  → broadcast {type:"review_result"}
  → setState({activeReview: null}) + scheduleNextReview()
```

**A deck build.**

```
model calls build_deck
  → agent.runWorkflow("DECK_BUILDER", {topic, cardCount})
  → DeckBuilder.run:
        step.do("outline")      → subtopics          (retried on failure)
        for each subtopic:
          step.do("generate-N") → cards              (retried independently)
          step.do("persist-N")  → this.agent.saveDeckCards(...)  via RPC
          reportProgress(...)   → agent.onWorkflowProgress → setState
        step.reportComplete(...)→ agent.onWorkflowComplete
```

Each `step.do` is durable: a transient inference failure retries that step alone, and the
whole run survives the Durable Object being evicted. A subtopic that fails permanently is
logged and skipped rather than failing the deck.

Cards from the workflow are written back **through the agent** rather than straight to
storage. That keeps deduplication, vector indexing and schedule updates in one place, so
cards mined from conversation and cards generated in bulk get identical treatment.

## Memory, in three layers

**SQLite** is the source of truth. Complete, never summarised.

**Vectorize** holds one 768-dimensional embedding per card, `namespace`d by learner id.
One index is shared across all learners; the namespace is what scopes recall. It serves
two purposes:

- `search_memory` — recall by meaning. "What do I know about consistency?" finds cards
  about the CAP theorem that never use the word.
- deduplication — before a card is saved, its embedding is compared against the index and
  against the other cards in the same batch. Anything above **0.92 cosine** is dropped. A
  model asked for cards on eight subtopics will happily produce the same fact three times
  in different words, and a `LIKE` query catches none of it.

**Rolling summary.** Llama 3.3 has a 24k-token context window. Rather than replay the
transcript, the model sees a stable summary of older turns plus the last ~12 verbatim,
trimmed to a 6k-token budget from the newest end backwards. The summary is regenerated
every 10 turns past a 16-turn threshold and stored in `profile`.

Ordering is deliberate — summary first, then the verbatim tail — so the prompt prefix
stays stable across turns and the KV prefix cache can hit. The system prompt is static
for the same reason, which is also why live statistics are exposed through a
`get_progress` tool rather than interpolated into the prompt.

`MEMORY_MODE="sql"` disables the vector layer entirely: recall falls back to `LIKE`, and
deduplication to exact question matching. Everything else is unchanged, so the project
runs for anyone who hasn't provisioned an index.

## Where the model is, and isn't

Every model call goes through `src/server/model.ts`. It is the only file that names a
model id or knows about AI Gateway.

Three calls also pass `this.sessionAffinity` — the Agent's stable per-instance key — so
requests from one learner are routed to the same backend replica and the prefix cache can
hit across turns.

Where the model is deliberately *not* trusted:

- **Grading** is routed in code, on `state.activeReview`, not by a tool.
- **Card mining** is a dedicated extraction pass, not a tool. Llama 3.3 emits prose or a
  tool call in a step and almost never both, so an `add_cards` tool placed after an
  explanation never fired in practice.
- **Grade extraction** uses a line format and a regex, not JSON mode. A truncated JSON
  object would lose a whole review; a malformed line loses nothing, because the parser
  falls back to a neutral passing grade rather than recording a lapse the learner didn't
  earn.
- **Card and subtopic extraction** likewise. A malformed line costs one card, not twenty.

All the parsers are pure functions with unit tests.

### The provider bug that shapes the turn

`workers-ai-provider@4.0.0` reads each Workers AI SSE chunk twice — once from the native
`chunk.response` field and again from the OpenAI-compatible
`chunk.choices[0].delta.content` — and emits both. Every delta arrives doubled.

Prose is recoverable. The duplication is exact adjacent pairs, so a
`wrapLanguageModel` middleware pairs them back down before anything downstream sees them
(`stream-dedupe.ts`, 14 tests).

Tool arguments are not. The provider accumulates them internally before any part reaches
the stream, so what surfaces is already corrupt JSON that never parses — the tool never
runs, and the loop exhausts its step budget emitting nothing.

Hence the split: tools on `generateText` where they work, prose on `streamText` where it
streams. `generateText` is unaffected throughout, which is what localised the fault to
`doStream`.

### Two binding details worth knowing

Both cost real debugging time and are easy to hit again:

- **Vectorize needs `"remote": true`** in `wrangler.jsonc`. It has no local emulator, so
  without it every call from `wrangler dev` fails with *"Binding MEMORY_INDEX needs to be
  run remotely"*. Workers AI is marked the same way, to make the dev-time usage explicit.
- **`returnMetadata` must be `"all"`, not `true`.** The binding's TypeScript type permits
  a boolean, but the Vectorize v2 API rejects it at the wire level with
  `VECTOR_QUERY_ERROR 40026`. Where metadata isn't needed, the option is omitted entirely.

## Client

No framework. `AgentClient` from `agents/client` opens the socket, and roughly 300 lines
of TypeScript render two things: a transcript (append-only, driven by events) and a
sidebar (replaced wholesale, driven by state).

The build is Vite with `@cloudflare/vite-plugin` and the `agents/vite` plugin. Output is
86 kB, 26 kB gzipped — almost all of it the SDK client.

Voice is a deliberate exception to the WebSocket rule. `MediaRecorder` produces a clip,
which is POSTed to `/api/transcribe`; the Worker runs it through Whisper and returns text,
which the client then sends as an ordinary chat message. Several hundred kilobytes of Opus
has no business on the channel carrying token deltas, and routing the transcript back
through the normal path means voice and typing converge on exactly the same agent code.
