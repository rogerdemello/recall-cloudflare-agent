# The agent

How Recall behaves, and why it behaves that way. For the infrastructure view see
[ARCHITECTURE.md](ARCHITECTURE.md).

## Premise

Most study apps make you author the flashcards. That's the part people don't do, which is
why most decks are abandoned after a week.

Recall inverts it: you have a conversation, and the cards are a by-product. The agent
decides what was worth remembering, writes the cards without being asked, and then — this
is the part that needs a Durable Object rather than a request handler — comes back on its
own initiative to test you.

## The loop

```
teach ──▶ mine cards ──▶ schedule ──▶ (time passes) ──▶ quiz ──▶ grade ──▶ reschedule
  ▲                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘
```

Verified end to end against live Workers AI — 17 checks covering streaming, unprompted
card mining, state replication, the scheduled quiz arriving with no request behind it,
SM-2 grading, semantic recall and transcript replay across a reconnect; plus 5 more for
the deck Workflow. See [DEMO.md](DEMO.md).

Nothing in the browser drives the middle of that loop. The alarm fires whether or not the
page is open; if it is, the question arrives immediately, and if not, it's waiting.

## System prompt

In `src/server/agent.ts` as `SYSTEM_PROMPT`. Verbatim:

```
You are Recall, a study coach. You teach things, and you quietly turn what you teach
into flashcards that you test the learner on later.

How you teach:
- Be concrete. A worked example beats a definition.
- Keep replies under 150 words unless asked to go deeper.
- Ask what they want to learn if they are vague, but only once — then pick something
  and start.

Flashcards are made from your explanations automatically, behind the scenes. Never
mention them, never offer to make them, never list them back.

Using memory:
- If the learner refers to an earlier session, or asks what they have covered, call
  search_memory first. Never guess at what they have studied.
- Before teaching a topic, it is reasonable to check whether they already have cards on it.

Deck building:
- Only call build_deck when they explicitly ask for a deck, a course, or to study a
  broad topic from scratch. It runs in the background; mention it is underway and stop
  there.

Never mention Durable Objects, Workers, SQLite, workflows or any other implementation
detail of how you work. You are a tutor, not a system.
```

Three things about it are load-bearing:

**It's static.** No interpolated statistics, no current date, no card counts. The prompt
prefix is byte-identical every turn, which is what makes `sessionAffinity` worth setting —
the KV prefix cache can hit on the system prompt and tool schemas instead of re-reading
them cold. Live numbers are available through `get_progress` when the model actually needs
them.

**"Never mention them."** Without that line, Llama 3.3 narrates: *"Great! I've saved 4
flashcards for you."* It makes the product feel like a form with extra steps. The cards
appearing in the sidebar is the feedback; saying it out loud is noise.

**The last paragraph.** Models are enthusiastic about explaining their own architecture,
especially when the subject matter is Cloudflare. Without an explicit prohibition, asking
Recall to teach you about Durable Objects produces a reply about how *it* is built.

## A turn is two model calls

This is forced by a provider bug, and it is worth understanding because it shapes
everything else.

`workers-ai-provider@4.0.0` reads each Workers AI SSE chunk twice — once from the native
`response` field and again from the OpenAI-compatible `choices[0].delta.content` — and
emits both. Every delta arrives doubled. Reproduced against live Workers AI:

```
generateText → "Durable Objects are stateful."                      correct
streamText   → ["D","D","urable Objects are","urable Objects are",
                " stateful"," stateful",".","."]                    doubled
```

Prose is recoverable: the duplication is exact adjacent pairs, so middleware pairs them
back down (`stream-dedupe.ts`, 14 tests). **Tool arguments are not.** The provider
accumulates them internally before any part reaches the stream, so what surfaces is
already corrupt:

```json
{"query": "{"query": "CloudCloudflareflare D Durableurable Objects"} Objects"}
```

That JSON never parses, so the tool never runs, the step ends with
`finish-reason: tool-calls`, and the loop burns its entire step budget emitting nothing.
Observed directly: five identical steps, zero text.

So each turn runs:

1. **Action pass** — `generateText` with tools, capped at 2 steps. Tools work correctly on
   the non-streaming path. Any prose it produces is discarded.
2. **Reply pass** — `streamText` with *no* tools, with the action pass's findings injected
   as a system message. Clean streaming text.

The action pass costs well under a second, so the learner still sees tokens promptly.

## Tools

Four, all in `src/server/tools.ts`, and none of them load-bearing.

**Few and flat.** Llama 3.3 is a capable tool-caller but not frontier-grade. Four tools
with shallow arguments get invoked correctly far more often than a dozen with nested
unions.

**Nothing correctness-critical.** A tool call is a probabilistic branch. If the model
forgets `search_memory`, the reply is a little less informed — recoverable, low stakes.
Anything whose absence breaks the product is routed in code instead.

| Tool | Arguments | Notes |
| --- | --- | --- |
| `search_memory` | `query` | Semantic recall over everything studied. Returns `{found: 0}` rather than an empty list when nothing matches, because an empty array invited confabulation. |
| `build_deck` | `topic`, `card_count` (5–40) | Starts the Workflow, returns immediately. The result explicitly tells the model *not* to list cards itself — otherwise it invents a plausible deck while the real one is still generating. |
| `quiz_me` | — | Pulls the most overdue card. The result says the question has already been shown, to stop the model repeating it in prose. |
| `get_progress` | — | Counts, mastery, streak. Exists so the system prompt can stay static. |

Several tool results carry an explicit `note` field steering what the model does next.
That's there because tool *results* are a more reliable place to put situational
instructions than the system prompt — they arrive adjacent to the decision point rather
than 800 tokens earlier.

## Card mining

The core feature, and deliberately **not** a tool.

It began as an `add_cards` tool the model was told to call after each explanation. Against
live Workers AI it essentially never fired: Llama 3.3 produces prose *or* a tool call in a
given step and almost never both, so a tool placed after an explanation is a tool that
never gets reached.

Instead, once the reply has been delivered, a separate extraction call runs over the
exchange:

```
DECK: <short lowercase topic>
Q: <question>
A: <answer>
```

…or the single word `NONE` when nothing is worth remembering. Same line format and the
same tested parser as the deck workflow. It runs *after* the reply is sent, so the extra
inference never delays what the learner is reading, and a failure is swallowed — losing
one turn's cards is self-correcting, since they can cover the topic again.

Exchanges under 120 characters are skipped without an inference.

## Grading

**Grading is not a tool call.** This is the most deliberate decision in the agent.

When `state.activeReview` is set, the next user message is intercepted before the chat
path runs. It never reaches `streamText`. It goes to a dedicated grading call, and the
result goes straight into SM-2.

The alternative — a `grade_answer` tool — would mean the learner's scheduling data depends
on the model choosing to invoke a function at the right moment. When it forgot, the answer
would be treated as ordinary conversation and the review would silently never close. State
routing makes the path unconditional.

### Getting a number out of prose

`src/server/grading.ts`. The model is asked for:

```
GRADE: <0-5>
FEEDBACK: <one or two sentences addressed to the learner>
```

Not JSON, and not `generateObject`. Structured-output modes on mid-sized open models fail
in ways that are annoying to recover from — truncated objects, schema drift, prose wrapped
around the JSON — and a failure here corrupts scheduling data rather than just looking
untidy. A line format is trivial to follow, trivial to parse, and degrades well.

The parser tolerates markdown bolding, lowercase labels, dash separators and a bare
leading digit. When it finds no grade at all it returns **3** — the lowest passing grade —
because a parse failure is a bug in this code, and recording it as a lapse would destroy a
repetition chain the learner actually earned. Eleven unit tests cover it.

Asking to see the answer before attempting it is graded **0** without a model call. It's a
lapse by definition, and spending an inference to confirm that would be silly.

### SM-2

`src/server/sm2.ts` — pure, no clock, no I/O, 23 unit tests.

Faithful to Wozniak's original, including the detail most reimplementations get wrong:

```
pass (grade >= 3):
    repetitions 1 → interval 1 day
    repetitions 2 → interval 6 days
    otherwise     → interval = round(previous_interval × previous_ease)
    ease += 0.1 − (5 − grade) × (0.08 + (5 − grade) × 0.02)
    ease  = max(1.3, ease)

lapse (grade < 3):
    repetitions → 0
    interval    → 1 day
    ease        → UNCHANGED
```

Two subtleties that are easy to get wrong and are pinned by tests:

- The new interval uses the **pre-update** ease. SM-2 computes `I(n) = I(n-1) × EF` and
  *then* adjusts EF. Using the post-update value inflates every interval.
- A lapse does **not** touch the ease factor. The original: *"start repetitions for the
  item from the beginning without changing the E-Factor."* Many implementations penalise
  ease here, which compounds and drives mature cards into the floor after one bad day.

**Mastery** is mean per-card progress toward a 21-day interval, clamped to 0–1.

**The clock.** `dueTimestamp(intervalDays, now, secondsPerDay)` converts SM-2 days to wall
time. `SECONDS_PER_DAY` defaults to **30** so intervals are observable during a demo
instead of requiring a return visit tomorrow. The algorithm is untouched; only the unit is
scaled. `86400` gives real behaviour.

Newly-taught cards get a `FIRST_REVIEW_DELAY_SECONDS` grace period (45s) before their
first quiz — being tested one second after being taught isn't spaced repetition.

## Scheduling

```ts
await this.schedule(delaySeconds, "runReview");
```

`scheduleNextReview()` cancels existing review alarms before setting a new one. Without
that, every saved card and every graded answer would stack another alarm and the learner
would be quizzed in bursts.

The alarm always points at `MIN(due_at)` across all cards — the single soonest card, not a
fixed interval. `runReview` then re-selects at fire time, so a card that became due in the
interim is picked up correctly.

Skipping is not failing: the card is pushed out by one interval-day with its ease and
repetition chain untouched.

## Deck building

`src/server/deck-workflow.ts`. Genuinely a Workflow rather than a loop in the agent,
because it's a dozen sequential inference calls and the failure modes matter.

```
step.do("outline")        → 3–8 subtopics
for each subtopic:
  step.do("generate-N")   → ~4 cards
  step.do("persist-N")    → RPC into the agent → dedup → SQLite + Vectorize
  reportProgress(...)     → agent.setState → sidebar progress bar
step.reportComplete(...)
```

What the Workflow buys:

- Each step is retried independently. A flaky inference on subtopic 5 doesn't re-run the
  outline or regenerate subtopics 1–4.
- A subtopic that fails permanently is logged and skipped. Losing one subtopic is better
  than losing the deck.
- The run survives the Durable Object being evicted mid-build.
- `reportProgress` gives the sidebar a real progress bar rather than a spinner.

An empty outline throws, so the step retries rather than "succeeding" with no plan.

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Generation throws mid-turn | Partial text kept, apologetic line appended, turn closes cleanly. Never a stuck spinner. |
| Action pass fails | Logged, findings dropped, the reply still streams — a failed lookup costs context, not the turn. |
| Card mining fails | Logged and swallowed. One turn's cards are lost; the learner can cover the topic again. |
| Turn produces no text | Emits "Done." rather than an empty bubble. |
| Grading call fails | Grade 3, honest feedback, card rescheduled soon. No lapse recorded. |
| Grade unparseable | Grade 3. Same reasoning. |
| Summarisation fails | Logged and skipped. The verbatim window still carries context; retried at the next threshold. |
| Workflow step fails permanently | That subtopic is skipped, progress reports it, the deck completes. |
| Vectorize unavailable | `MEMORY_MODE="sql"` falls back to keyword search and literal dedup. |
| Vector cleanup fails on reset | Logged and ignored. Stranded vectors are harmless — recall only surfaces cards that still exist in SQLite. |

The through-line: a model or network failure should cost the learner a little quality,
never their data and never a hung UI.
