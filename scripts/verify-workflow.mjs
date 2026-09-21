/**
 * Verifies the DeckBuilder Cloudflare Workflow end to end.
 *
 * Watches the agent's synced state for workflow progress, which is the same
 * signal the sidebar renders.
 */

const PORT = process.argv[2] ?? "5174";
const LEARNER = `wf-${Date.now().toString(36)}`;
const ws = new WebSocket(`ws://localhost:${PORT}/agents/study-coach/${LEARNER}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const progressLabels = [];
let state = null;
let sawRunning = false;
let completed = null;

ws.addEventListener("message", (event) => {
  if (typeof event.data !== "string") return;
  let m;
  try {
    m = JSON.parse(event.data);
  } catch {
    return;
  }

  if (m.type === "cf_agent_state") {
    state = m.state;
    const wf = state?.workflow;
    if (wf) {
      const line = `${wf.status} ${wf.done}/${wf.total} — ${wf.label}`;
      if (progressLabels.at(-1) !== line) {
        progressLabels.push(line);
        console.log(`   ${line}`);
      }
      if (wf.status === "running") sawRunning = true;
      if (wf.status === "complete") completed = wf;
    }
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
  setTimeout(() => reject(new Error("connect timeout")), 15000);
});

console.log(`connected as "${LEARNER}"\n--- requesting a deck ---`);
ws.send(
  JSON.stringify({
    type: "chat",
    id: crypto.randomUUID(),
    text: "Build me a deck on the CAP theorem.",
  }),
);

// Workflows are durable and multi-step; give it real time.
const deadline = Date.now() + 300000;
while (Date.now() < deadline && !completed) {
  await new Promise((r) => setTimeout(r, 2000));
}

console.log("");
check("Workflow started", sawRunning);
check("Workflow reported step-by-step progress", progressLabels.length >= 2, `${progressLabels.length} updates`);
check("Workflow completed", !!completed, completed?.label ?? "");
check("Deck produced cards", (state?.cardCount ?? 0) > 0, `cardCount=${state?.cardCount}`);
check(
  "Cards landed in a deck",
  (state?.decks?.length ?? 0) > 0,
  state?.decks?.map((d) => `${d.deck}(${d.cardCount})`).join(", "),
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(56)}`);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
console.log(`${"=".repeat(56)}`);
ws.close();
process.exit(failed.length ? 1 : 0);
