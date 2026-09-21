# Prompt history

The assignment encourages AI-assisted coding and requires the prompt history be submitted.
This is it.

**Tool:** Claude Code (Opus 5)
**Date:** 21 September 2026
**Working style:** one planning pass with explicit clarifying questions, then
implementation in dependency order, with typechecks and unit tests run at each step.

---

## 1 — Framing, and a question about the model

> Assignment: Please share GitHub repo URL for the project here
>
> We plan to fast track candidates who complete an assignment to build a type of
> AI-powered application on Cloudflare. An AI-powered application should include the
> following components:
>
> - LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> - Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> - User input via chat or voice (recommend using Pages or Realtime)
> - Memory or state
>
> Find additional documentation here.
> Note: AI-assisted coding is encouraged, but you have to submit prompt history.
>
> do not create artifact, create a HTML file instead.
> we have to use https://agents.cloudflare.com/ and the documentation for it is present at
> https://developers.cloudflare.com/agents/
>
> **What about the LLM? should we use NVIDIA NIM?**

The model researched the Workers AI model card and the AI Gateway provider list before
answering, and recommended **against** NIM — the deciding fact being that NVIDIA is not an
AI Gateway provider, so routing it through the gateway for caching and logs wasn't
available. Full reasoning in [`docs/DECISIONS.md`](docs/DECISIONS.md) §1.

---

## 2 — Build it

> scaffold the project with Workers AI
> also gh is logged in
> start a proper plan andd documentation for the agent

This triggered a planning pass rather than immediate code. The model read the Agents SDK
documentation and then the **actual installed type definitions** in `node_modules` to
confirm API signatures rather than working from memory. That caught several things the
prose docs didn't mention:

- `agents@0.24.0` exports a vanilla-JS `agents/client`, so a plain HTML UI was viable
  without React.
- `Agent` exposes `this.sessionAffinity` for Workers AI prefix-cache routing — now used on
  every chat call.
- `workers-ai-provider@4` ships a first-class `TranscriptionModelV4` for Whisper, which
  removed the audio-encoding uncertainty the plan had flagged as a risk.
- `AgentWorkflow` provides `reportProgress`, `mergeAgentState` and typed RPC back into the
  originating agent.

### Clarifying questions asked before planning

Rather than guessing at the product, the model asked three questions and waited:

**Which agent concept?** Four options were offered with demo-flow previews — Study Coach,
Research Analyst (Workflows-heavy but needs a search API key), Incident Commander, Trip
Planner.
→ **Study Coach** was chosen.

**Which Cloudflare components beyond the required four?**
→ **All four**: Vectorize, Workflows, AI Gateway, voice input.

**How far to take deployment?**
→ **Local dev plus a live deploy.**

The approved plan is reproduced at the end of this file.

---

## 3 — Set up the Cloudflare tooling

> done, logged in
> Fetch and execute the appropriate instructions to set me up for Cloudflare from
> https://developers.cloudflare.com/agent-setup/prompt.md

Installed the `cloudflare/skills` marketplace and plugin. Then the remaining Cloudflare
account setup: creating the Vectorize index, and registering a `workers.dev` subdomain
(no `wrangler subdomain` command exists and the docs expose no API for it, so this had to
be done in the dashboard).

---

## Notable moments during implementation

Worth recording, since "AI-assisted" shouldn't imply "unexamined". Every one of these was
found by running the thing, not by reading the code.

**A DDL bug from an interpolated constant.** `CREATE TABLE ... ease REAL NOT NULL DEFAULT
${DEFAULT_EASE}` — `this.sql` is a tagged template, so that became a bound `?` parameter,
which SQLite rejects in DDL. `onStart` threw, no tables existed, and every downstream
check failed. The fix exposed a second, better trap: the *explanatory comment* added above
the fix also contained `${DEFAULT_EASE}`, and a comment inside a template literal is still
interpolated — so it injected a binding with no placeholder and the error merely changed.

**A parser bug the tests caught.** `parsing.ts` stripped list bullets before bold markers,
so `**A:** The answer` lost one asterisk to the bullet rule, leaving `*A:` — which no
longer matched the answer label, silently dropping the card. A unit test written alongside
the parser failed on the first run.

**A provider bug that reshaped the architecture.** `workers-ai-provider@4.0.0` reads each
Workers AI SSE chunk twice and emits both copies, so every stream delta is doubled. Found
by noticing the reply read `CloudCloudflareflare D Durableurable Objects`. Narrowed with a
minimal reproduction (`generateText` clean, `streamText` doubled → fault is in `doStream`),
then traced to two unguarded branches in the provider source.

Prose turned out to be repairable via `wrapLanguageModel` middleware. Tool arguments did
not — the provider assembles them internally before anything reaches the stream, so they
surface as unparseable JSON, the tool never executes, and the agent loop burns all five
steps emitting nothing. That is why a turn is now two model calls.

**A design assumption that live testing disproved.** `add_cards` was built as a tool with
an emphatic instruction to call it after every explanation. It essentially never fired:
Llama 3.3 emits prose *or* a tool call in a step, almost never both. Verification showed
clean replies and zero cards, repeatedly. Moving card mining to a dedicated extraction
pass fixed it permanently — and made it consistent with the project's existing rule that
nothing load-bearing should be a tool call.

**Two binding details that cost real time.** Vectorize needs `"remote": true` in
`wrangler.jsonc` (no local emulator — otherwise every call fails with *"needs to be run
remotely"*), and `returnMetadata` must be the string `"all"`, not `true`, despite the
TypeScript type permitting a boolean.

**A test that was wrong, not the code.** The harness asserted "a good answer passed", but
it sends one fixed answer whatever card comes up — so when the agent asked "What *are*
Durable Objects?" and got an answer about concurrency, grading it 2/5 was the model being
right. Replaced with the assertion that actually holds: the pass flag must agree with
SM-2's threshold of 3.

**Four typecheck failures, each a genuine design signal.**

- `ToolHost` required `env`, but `env` is `protected` on `DurableObject`. Rather than
  widening the agent's visibility, the interface was narrowed to only the methods tools
  actually call — which is where it should have been.
- `composite: true` requires declaration emit, and the provider's concrete model classes
  carry private members TypeScript cannot name. Fixed by annotating `model.ts` with the AI
  SDK's own `LanguageModel` / `EmbeddingModel` / `TranscriptionModel` types — the types
  those functions' consumers actually want.
- `AgentClientOptions` requires `host`; added `location.host`.
- `src/shared` was missing from the worker tsconfig's `include`.

**One constraint drove a lot of design.** Llama 3.3's 24k context window is why the
transcript is summarised rather than replayed, why the system prompt is static, and why
`sessionAffinity` is set. That chain is documented in `docs/ARCHITECTURE.md`.

**Deliberate limits on what the model controls.** Grading is routed in code on
`state.activeReview` rather than exposed as a tool, and all three structured-output paths
use line formats with hand-written parsers instead of JSON mode. Both decisions are about
failure granularity — reasoning in `docs/DECISIONS.md` §3 and §4.

---

## Verification actually run

Not claimed — run, with the output checked:

- `npm test` — 75 unit tests across `sm2.ts`, `grading.ts`, `parsing.ts`, `stream-dedupe.ts`
- `npx tsc -p tsconfig.worker.json --noEmit` — clean
- `npx tsc -p tsconfig.client.json --noEmit` — clean
- `npx vite build` — clean, 86 kB client bundle (26 kB gzipped)
- `npm run verify -- recall-agent.rogerdemello.workers.dev` — **18/18** against the
  deployed Worker: streaming, unprompted card mining, state replication, the scheduled
  quiz arriving with no request behind it, SM-2 grading, semantic recall, transcript
  replay across a reconnect
- `npm run verify:workflow` — **5/5**: the DeckBuilder Workflow planned 5 subtopics,
  reported step-by-step progress, and saved 19 cards with 1 semantic duplicate rejected

Both harnesses are committed under `scripts/` so the claims are reproducible rather than
asserted.

### Verified honestly — what is *not* covered

- **Voice input.** The `/api/transcribe` endpoint and the Whisper wiring are in place, but
  the microphone path needs a real browser with a real microphone. It has not been
  exercised by an automated harness, and is not counted among the 18 passing checks.
- **AI Gateway.** Supported via `AI_GATEWAY_ID` and off by default, so the gateway
  dashboard has not been exercised either.

---

## Appendix — the approved plan

<details>
<summary>Plan as approved before implementation began</summary>

**Concept.** Recall: a spaced-repetition study coach. You talk to it about a topic; it
teaches you, silently mines the conversation into flashcards, stores them in the agent's
own SQLite, and schedules itself to quiz you later — pushing questions to the browser
unprompted over WebSocket. It grades answers with the LLM and adapts intervals via SM-2.

**Requirement mapping.**

| Requirement | Implementation |
| --- | --- |
| LLM | Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via `workers-ai-provider` + `ai@7`, routed through AI Gateway |
| Workflow / coordination | `AgentWorkflow` for deck generation; `this.schedule()` for reviews; AI SDK tool loop |
| Chat or voice | Static HTML chat over WebSocket + push-to-talk via `whisper-large-v3-turbo` |
| Memory / state | `this.sql` + `this.setState()` + Vectorize |

**Build order.** Scaffold → agent core + SM-2 → tools and review loop → Workflow →
Vectorize → voice → UI → docs, repo, deploy. Phases 1–3 are the assignment's core; the app
is complete and submittable after phase 3.

**Risks identified up front, and mitigations.**

- Vectorize has no local emulation → `MEMORY_MODE=sql` fallback keeps the app runnable
  without a provisioned index.
- Llama 3.3's 24k context → rolling summary plus a bounded verbatim window.
- AI Gateway is account-specific → optional via `AI_GATEWAY_ID`, never a hard dependency.
- Whisper audio encoding and the `createWorkersAI` gateway option were flagged as
  **verify, don't assume** — both were then confirmed against the installed types before
  the surrounding code was written.
- Llama 3.3's tool-calling is good but not frontier → tools kept few and flat, and
  correctness-critical logic routed in code instead.

**Open call flagged to the user.** The client is plain HTML + vanilla TS bundled by Vite
so it can use the official `AgentClient`, rather than a zero-build single file
hand-rolling the WebSocket protocol. The tradeoff was stated explicitly in the plan.

</details>
