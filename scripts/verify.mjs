/**
 * End-to-end verification against a running `wrangler dev`.
 *
 * Drives the agent over a raw WebSocket exactly as the browser would, and
 * asserts on what actually comes back. Node 24 has a native WebSocket, so no
 * dependency is needed.
 */

// Accepts either a local port ("5174") or a deployed host
// ("recall-agent.rogerdemello.workers.dev"), so the same checks run against
// local dev and production.
const TARGET = process.argv[2] ?? "5173";
const LEARNER = process.argv[3] ?? `verify-${Date.now().toString(36)}`;
const URL_BASE = TARGET.includes(".")
  ? `wss://${TARGET}/agents/study-coach/${LEARNER}`
  : `ws://localhost:${TARGET}/agents/study-coach/${LEARNER}`;

const log = (...a) => console.log(...a);
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const ws = new WebSocket(URL_BASE);

/** Everything the server sent, in order. */
const received = [];
let state = null;

const waiters = [];
function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve) => {
    const existing = received.find(predicate);
    if (existing) return resolve(existing);

    const timer = setTimeout(() => {
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      log(`   (timed out waiting for ${label} after ${timeoutMs}ms)`);
      resolve(null);
    }, timeoutMs);

    const entry = {
      predicate,
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    };
    waiters.push(entry);
  });
}

ws.addEventListener("message", (event) => {
  if (typeof event.data !== "string") return;
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }

  // The SDK's own state frames.
  if (msg.type === "cf_agent_state") {
    state = msg.state;
    return;
  }

  received.push(msg);

  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].predicate(msg)) {
      const [w] = waiters.splice(i, 1);
      w.resolve(msg);
    }
  }
});

ws.addEventListener("error", (e) => log("WS ERROR", e.message ?? e));

function send(obj) {
  ws.send(JSON.stringify(obj));
}

function textOf(turnId) {
  return received
    .filter((m) => m.type === "token" && m.id === turnId)
    .map((m) => m.delta)
    .join("");
}

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
  setTimeout(() => reject(new Error("connect timeout")), 15000);
});

log(`connected as learner "${LEARNER}"\n`);
check("WebSocket connects to the agent", true);

// ---------------------------------------------------------------- 1. chat
log("\n--- 1. teaching turn ---");
const turn1 = crypto.randomUUID();
send({
  type: "chat",
  id: turn1,
  text: "Teach me about Cloudflare Durable Objects. Keep it to a short paragraph.",
});

const started = await waitFor((m) => m.type === "start", 45000, "stream start");
check("Assistant turn starts streaming", !!started);

const done1 = await waitFor(
  (m) => m.type === "done" && m.id === started?.id,
  180000,
  "turn completion",
);
const reply = done1?.content ?? textOf(started?.id);
check("Reply streamed and completed", !!done1, `${reply.length} chars`);
if (reply) log(`   reply: ${reply.slice(0, 220).replace(/\n/g, " ")}…`);

const tokenCount = received.filter((m) => m.type === "token").length;
check("Response arrived as multiple token deltas", tokenCount > 3, `${tokenCount} deltas`);

// --------------------------------------------------------- 2. card mining
// Mining is a separate extraction pass that runs *after* the reply is
// delivered, so this has to wait for it rather than assert immediately.
log("\n--- 2. card mining (runs after the reply) ---");
const mined = await waitFor(
  (m) => m.type === "tool" && m.name === "add_cards",
  120000,
  "card mining",
);
check("Cards mined from the conversation unprompted", !!mined, mined?.label ?? "");

// Give the follow-up state broadcast a moment to land.
await new Promise((r) => setTimeout(r, 2500));

// ------------------------------------------------------------- 3. state
log("\n--- 3. synced state ---");
check("Agent state replicated to client", !!state, state ? `${state.cardCount} cards` : "");
check("Cards persisted to SQLite", (state?.cardCount ?? 0) > 0, `cardCount=${state?.cardCount}`);
check(
  "Deck rollup computed",
  (state?.decks?.length ?? 0) > 0,
  state?.decks?.map((d) => `${d.deck}(${d.cardCount})`).join(", "),
);
check(
  "Memory mode reports vector",
  state?.memoryMode === "vector",
  `memoryMode=${state?.memoryMode}`,
);

// -------------------------------------------------- 4. unprompted review
log("\n--- 4. scheduled review (waiting for the agent's alarm) ---");
const quiz = await waitFor((m) => m.type === "review_start", 120000, "scheduled review");
check("Agent pushed a quiz unprompted", !!quiz, quiz ? `"${quiz.question}"` : "");

let graded = null;
if (quiz) {
  log("\n--- 5. grading ---");
  send({
    type: "chat",
    id: crypto.randomUUID(),
    text: "Only one instance runs at a time for a given id, so you get single-threaded execution and no races on its state.",
  });

  graded = await waitFor((m) => m.type === "review_result", 180000, "grade");
  check("Answer was graded", !!graded, graded ? `grade ${graded.grade}/5` : "");
  check(
    "Grade is in SM-2 range",
    graded != null && graded.grade >= 0 && graded.grade <= 5,
    `grade=${graded?.grade}`,
  );
  // Deliberately NOT asserting that this particular answer passes. The harness
  // sends one fixed answer whatever card comes up, so whether it earns a 3 is
  // the model's judgement, not a property of the system. What must always hold
  // is that the pass flag agrees with SM-2's threshold of 3.
  check(
    "Pass flag agrees with the SM-2 threshold",
    graded != null && graded.passed === graded.grade >= 3,
    `grade=${graded?.grade}, passed=${graded?.passed}`,
  );
  check(
    "Feedback was returned",
    (graded?.feedback?.length ?? 0) > 0,
    `${graded?.feedback?.length ?? 0} chars`,
  );
  check(
    "Interval advanced past zero",
    (graded?.nextDueInDays ?? 0) >= 1,
    `nextDueInDays=${graded?.nextDueInDays}`,
  );
}

// --------------------------------------------------- 6. memory / recall
log("\n--- 6. semantic recall ---");
const turn2 = crypto.randomUUID();
send({
  type: "chat",
  id: turn2,
  text: "What have I studied so far? Search your memory before answering.",
});
const start2 = await waitFor(
  (m) => m.type === "start" && m.id !== started?.id,
  45000,
  "second turn",
);
const done2 = await waitFor(
  (m) => m.type === "done" && m.id === start2?.id,
  180000,
  "second turn completion",
);
check("Second turn completed", !!done2);
const searched = received.filter((m) => m.type === "tool" && m.name === "search_memory");
check("Model used search_memory", searched.length > 0, `${searched.length} call(s)`);

// ------------------------------------------------------- 7. persistence
log("\n--- 7. persistence across reconnect ---");
ws.close();
await new Promise((r) => setTimeout(r, 1200));

const ws2 = new WebSocket(URL_BASE);
const history = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 20000);
  ws2.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "history") {
        clearTimeout(timer);
        resolve(msg);
      }
    } catch {}
  });
});
check(
  "Transcript replayed on reconnect",
  (history?.messages?.length ?? 0) > 0,
  `${history?.messages?.length} messages`,
);
ws2.close();

// ------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
log(`\n${"=".repeat(60)}`);
log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  log("\nFailures:");
  for (const f of failed) log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
}
log(`${"=".repeat(60)}`);
process.exit(failed.length ? 1 : 0);
