# Recall

A spaced-repetition study coach that teaches you something, quietly turns it into
flashcards, and then **wakes itself up later to test you on them**.

Built on the [Cloudflare Agents SDK](https://agents.cloudflare.com/). Every learner gets
their own Durable Object, which holds their conversation, their cards, their review
schedule, and their streak — and which can run on its own clock whether or not anyone
has the page open.

```
You    ▸ Teach me about Durable Objects
Recall ▸ [explains, with an example]
         · saving 4 cards to "durable objects"          ← you never asked it to

  … 45 seconds pass, nobody types anything …

Recall ▸ REVIEW · durable objects
         What guarantees does a Durable Object give you about concurrency?
You    ▸ only one instance runs at a time, so no races
Recall ▸ That's the core of it.
         grade 4/5 · next in 6 days
```

---

## What it demonstrates

| Assignment requirement | How it's met |
| --- | --- |
| **LLM** | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) for chat, grading, outlining and card writing — via `workers-ai-provider` + the Vercel AI SDK, routed through **AI Gateway** when one is configured. No API keys. |
| **Workflow / coordination** | A real **Cloudflare Workflow** (`DeckBuilder`) for durable multi-step deck generation, plus `this.schedule()` for self-triggered reviews and the AI SDK tool loop for in-turn coordination. |
| **User input via chat or voice** | A static HTML chat UI over WebSocket, **and** push-to-talk using `@cf/openai/whisper-large-v3-turbo`. |
| **Memory / state** | Three layers: SQLite inside the Durable Object (source of truth), **Vectorize** for semantic recall and near-duplicate detection, and a rolling LLM-generated summary that lets a 24k-token model hold a much longer conversation. |

## Quickstart

```bash
npm install
npx wrangler login                                            # Workers AI needs an account
npx wrangler vectorize create recall-memory \
  --dimensions=768 --metric=cosine                            # semantic memory
npm run dev
```

Open the printed URL. That's it — there are no API keys and no `.env` file.

**Without a Vectorize index?** Set `"MEMORY_MODE": "sql"` in `wrangler.jsonc` and skip the
`vectorize create` step. Recall degrades to keyword search and literal deduplication;
everything else works unchanged.

```bash
npm test          # 51 unit tests — SM-2, grade parsing, LLM output parsing
npm run typecheck # both tsconfigs: worker and browser
npm run deploy    # build + wrangler deploy
```

## Seeing it work

Full walkthrough in [`docs/DEMO.md`](docs/DEMO.md). The short version:

1. **"Teach me about Cloudflare Durable Objects."** Watch the reply stream in, and watch
   a `saving 4 cards` chip appear that you never asked for. The card count in the sidebar
   ticks up.
2. **Stop typing and wait ~45 seconds.** The agent pushes a question at you unprompted.
   Nothing in the browser polled for it — a Durable Object alarm fired.
3. **Answer it badly on purpose.** You get graded, shown the real answer, and the card
   comes back soon. Answer the next one well and the interval stretches out.
4. **"Build me a deck on the CAP theorem."** A Workflow starts; the sidebar shows real
   step-by-step progress as each subtopic is generated and persisted.
5. **Reload the page.** Conversation, cards, streak and schedule are all still there.

> **On the clock.** SM-2 works in days, which makes for a poor demo. `SECONDS_PER_DAY`
> in `wrangler.jsonc` compresses one "day" to 30 seconds so intervals are observable in
> real time. The algorithm is untouched — only the unit is scaled. Set it to `86400` for
> real behaviour.

## How it fits together

```
Browser — static HTML, vanilla TS, no framework
  │  WebSocket ....... chat, token stream, synced state, unprompted quiz pushes
  │  POST /api/transcribe ... audio blob → Whisper
  ▼
Worker (routeAgentRequest)
  ▼
StudyCoach — one Durable Object per learner
  ├─ this.sql ........ cards · reviews · transcript · profile
  ├─ this.setState ... counts, mastery, streak, active review, workflow progress
  ├─ this.schedule ... wakes the agent up to quiz you
  ├─ tools ........... add_cards · search_memory · build_deck · quiz_me · get_progress
  └─ runWorkflow ──▶ DeckBuilder — durable, retried per step, RPCs cards back
Workers AI ... Llama 3.3 · bge-base-en-v1.5 · whisper-large-v3-turbo
Vectorize .... 768-dim cosine index, namespaced per learner
```

Detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the agent's own design — system
prompt, tool contracts, memory model, the SM-2 maths — in [`docs/AGENT.md`](docs/AGENT.md).

## Two decisions worth reading

Both are argued properly in [`docs/DECISIONS.md`](docs/DECISIONS.md).

**Workers AI over an external LLM.** The brief allowed any LLM, and NVIDIA NIM was
considered. Workers AI won on three counts: it needs no API key, so this repo is
clone-and-run; it is the only option that is a *binding* rather than an HTTP call with
egress latency; and NIM is not an AI Gateway provider, so routing it through the gateway
for caching and logs was not possible. `src/server/model.ts` is the single swap point if
that judgement should ever change.

**Grading is not a tool call.** When a review is open, the next message is intercepted and
graded in code before the model ever sees it as chat. Letting the LLM decide *when* to
grade would make the learner's scheduling data depend on the model having a good turn.
Tools are only used for things where a missed call is a mild inconvenience.

## Layout

```
src/server/
  index.ts           Worker entry — routing + /api/transcribe
  agent.ts           StudyCoach: the agent loop, review loop, tool host
  deck-workflow.ts   DeckBuilder: durable multi-step deck generation
  tools.ts           the five tools the model can call
  memory.ts          Vectorize + rolling summary + context assembly
  schema.ts          SQLite schema and every query
  sm2.ts             spaced repetition — pure, no I/O
  grading.ts         parsing a grade out of model prose
  parsing.ts         parsing subtopics and cards out of model prose
  model.ts           the one place the LLM is chosen
src/client/          index.html + app.ts + voice.ts + styles.css
src/shared/          the wire protocol, compiled into both sides
test/                51 tests over the pure logic
```

`sm2.ts`, `grading.ts` and `parsing.ts` are pure and separately tested. That is deliberate:
they hold the logic where a silent bug would corrupt a learner's schedule or quietly drop
generated cards, and none of it needs a Worker runtime to verify.

## Prompt history

The assignment asks for it: [`PROMPTS.md`](PROMPTS.md).

## Licence

MIT.
