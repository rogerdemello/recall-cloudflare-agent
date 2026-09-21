# Demo script

Roughly three minutes, and it shows all four assignment requirements working together.

## Setup

```bash
npm install
npx wrangler login
npx wrangler vectorize create recall-memory --dimensions=768 --metric=cosine
npm run dev
```

Open the printed URL. Optionally open `wrangler tail` in a second terminal — the scheduled
callbacks and workflow steps are visible there, which makes the "nothing is polling" claim
checkable rather than just stated.

> `SECONDS_PER_DAY` is 30 in `wrangler.jsonc`, so one SM-2 "day" passes every 30 seconds.
> This is what makes the scheduler observable inside a demo. Set it to `86400` for real
> behaviour.

---

## 1 · Teaching, and cards you didn't ask for

> **Teach me about Cloudflare Durable Objects**

Watch for:

- The reply **streams** token by token.
- A chip appears: `saving 4 cards to "durable objects"`. Nobody asked for that — the
  model called `add_cards` on its own, and the system prompt told it to do so silently.
- The sidebar updates: **cards 4**, a new deck row. That sidebar has no fetch calls in it;
  it is a pure function of the agent's synced state.

## 2 · The agent comes back on its own

**Stop typing. Wait about 45 seconds.**

A question appears, unprompted:

```
REVIEW · durable objects
What guarantees does a Durable Object give you about concurrency?
```

This is the part worth pausing on. The browser did not poll. A Durable Object alarm fired,
the agent woke, selected the most overdue card and pushed it down the socket. It would
have fired with the tab closed.

In `wrangler tail` you'll see the callback run with no corresponding inbound request.

## 3 · Getting it wrong, then right

**Answer badly on purpose** — "something about state I think".

- Graded **1 or 2 of 5**, with the correct answer revealed underneath.
- `next in 1 day` — the repetition chain reset.

Now **answer the next one properly**. Grade 4–5, and the interval stretches: `next in 6
days`. That's SM-2 adapting per card.

Worth saying out loud: that answer never went through the chat model as conversation.
Because a review was open, it was intercepted and routed straight to grading — so the
scheduling maths doesn't depend on the model choosing to call a tool at the right moment.

## 4 · A real Workflow

> **Build me a deck on the CAP theorem**

The sidebar shows a **Deck build** panel with a progress bar that actually advances:

```
Planned 5 subtopics
Added 4 cards on "Consistency models"
Added 4 cards on "Partition tolerance"
...
Added 17 cards (3 duplicates skipped)
```

Each subtopic is a separate durable `step.do`. A transient inference failure retries that
step alone; a permanent one skips that subtopic and the deck still completes. The run
survives the Durable Object being evicted mid-build.

The "3 duplicates skipped" line is Vectorize doing real work — those cards were rejected
at 0.92 cosine similarity against cards already indexed, including ones generated moments
earlier in the same run.

## 5 · Memory that isn't keyword matching

> **What have I learned about consistency?**

A `searching memory` chip appears, and the agent answers using cards from the CAP deck —
**including cards that never contain the word "consistency"**. That's a 768-dimensional
embedding lookup, namespaced to this learner, not a `LIKE` query.

## 6 · Voice

Click the **🎙** button, allow the microphone, and say *"explain eventual consistency to
me"*. Click again to stop.

The clip is posted to `/api/transcribe`, Whisper transcribes it on Workers AI, and the
transcript is sent as an ordinary chat message — the same path typing takes.

## 7 · It's actually durable

**Hard-refresh the page.**

Everything is still there: the full conversation, every card, the streak, the mastery
percentage, and the pending review schedule. Nothing was in browser memory.

Then **open `?learner=someone-else`** in another tab. Empty state, zero cards — a
different Durable Object with its own database. No `WHERE user_id = ?` is involved; the
isolation is structural.

---

## If you only have 60 seconds

Steps 1, 2 and 3. Teach it something, wait for it to quiz you unprompted, answer wrong and
watch the interval collapse. That's the LLM, the coordination, the memory and the state
all in one motion.

## Checking the claims

| Claim | How to check |
| --- | --- |
| Nothing polls | `wrangler tail` — the review callback runs with no inbound request |
| Reviews survive the tab closing | Close the tab during step 2, reopen after a minute — the question is waiting |
| Workflow steps are independent | `wrangler tail` during step 4 — each `step.do` logs separately |
| Vectorize is really running | Step 5 returns cards with no lexical overlap; the skipped-duplicate count in step 4 |
| Learners are isolated | `?learner=` in step 7 |
| SM-2 is correct | `npm test` — 23 tests, including the two subtleties most implementations get wrong |

## Under the hood, if asked

- **Model** — Llama 3.3 70B on Workers AI. `src/server/model.ts` is the only file that
  names it. Also `bge-base-en-v1.5` for embeddings and `whisper-large-v3-turbo` for voice.
- **AI Gateway** — set `AI_GATEWAY_ID` in `wrangler.jsonc` to route every call through a
  gateway for caching, logs and analytics. Unset means direct, so nobody needs to
  provision one to run this.
- **Context window** — 24k. The model sees a rolling summary plus the last ~12 turns, not
  the full transcript. `docs/ARCHITECTURE.md` has the detail.
- **Tests** — `npm test` covers SM-2, grade parsing and card/outline parsing: the three
  places where a silent bug would corrupt a schedule or drop generated cards.
