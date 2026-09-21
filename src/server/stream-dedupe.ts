/**
 * Works around a double-emission bug in `workers-ai-provider@4.0.0`.
 *
 * The provider's streaming path reads a Workers AI SSE chunk twice: once from
 * the native `chunk.response` field, and again from the OpenAI-compatible
 * `chunk.choices[0].delta.content` field. Current Workers AI responses carry the
 * payload in *both*, and the second branch has no guard against the first having
 * already fired — so every delta is enqueued twice.
 *
 * Reproduced minimally against live Workers AI:
 *
 *   generateText  → "Durable Objects are stateful."          (correct)
 *   streamText    → ["D","D","urable Objects are",
 *                    "urable Objects are"," stateful",
 *                    " stateful",".","."]                    (each delta twice)
 *
 * The non-streaming path is unaffected, which confirms the fault is in
 * `doStream`. 4.0.0 is the latest release, so there is no upstream fix to take.
 *
 * **It is not only cosmetic.** The same doubling corrupts `tool-input-delta`
 * parts, so the JSON the SDK assembles for a tool call comes out as:
 *
 *   {"query": "{"query": "CloudCloudflareflare D Durableurable Objects"} Objects"}
 *
 * which fails to parse. The tool never executes, the step ends with
 * `finish-reason: tool-calls`, and the agent loop spins through its whole step
 * budget producing nothing. That is why this is fixed as *middleware* around the
 * model rather than by filtering `textStream` at the call site: it has to be
 * repaired before the SDK assembles tool arguments from those deltas.
 *
 * ---
 *
 * The duplication is *exact adjacent pairs*, so it can be undone without
 * guessing: hold each delta back by one, and when the next one is identical,
 * emit a single copy and consume both.
 *
 * This stays correct even for content that legitimately repeats. Under the bug
 * a genuine "the the" arrives as four deltas, which pair down to two — the right
 * answer. The only case it gets wrong is a *fixed* provider emitting two
 * identical adjacent deltas, where it would collapse them to one; that is rare,
 * recoverable, and vastly preferable to shipping doubled prose and broken tools.
 *
 * Costs exactly one delta of latency. Delete this file and the `wrapLanguageModel`
 * call in `model.ts` once the provider is fixed.
 */

import type { LanguageModelMiddleware } from "ai";

export class DeltaDeduper {
  /** The delta waiting to see whether its twin follows. */
  private held: string | null = null;

  /**
   * Feed one delta in; get back the deltas that should actually be emitted.
   *
   * Returns an array because a delta may release the previously held one, emit
   * nothing, or (on flush) release a trailing value.
   */
  push(delta: string): string[] {
    if (this.held === null) {
      this.held = delta;
      return [];
    }

    if (this.held === delta) {
      // The twin arrived. Emit one copy and consume both.
      this.held = null;
      return [delta];
    }

    // Different delta, so the held one was not duplicated. Release it and hold
    // the new one.
    const release = this.held;
    this.held = delta;
    return [release];
  }

  /** Release anything still held. Call once the stream ends. */
  flush(): string[] {
    if (this.held === null) return [];
    const release = this.held;
    this.held = null;
    return [release];
  }
}

/** The delta-carrying stream parts we need to repair. */
type DeltaPart = { type: string; id?: string; delta?: string };

/**
 * Middleware that undoes the double emission for every delta stream the model
 * produces — prose *and* tool-call arguments.
 *
 * Pairing is tracked per `type:id`, because text deltas and tool-input deltas
 * interleave: the provider processes one SSE chunk as
 * `text-delta → tool parts → text-delta`, so a single global pairing state
 * would break the pair across the tool parts sitting between them.
 *
 * Held deltas are released when that id's `*-end` marker arrives, or at stream
 * close. Other part types pass through untouched and deliberately do *not*
 * trigger a flush, for the interleaving reason above.
 */
export function workersAiDoubleEmissionFix(): LanguageModelMiddleware {
  return {
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();

      const dedupers = new Map<string, DeltaDeduper>();
      const lastPart = new Map<string, DeltaPart>();

      const keyFor = (part: DeltaPart) => `${part.type}:${part.id ?? ""}`;

      /** Re-emit a delta value using the shape of the part it came from. */
      const rebuild = (template: DeltaPart, delta: string): DeltaPart => ({
        ...template,
        delta,
      });

      const repair = new TransformStream<DeltaPart, DeltaPart>({
        transform(part, controller) {
          const type = part?.type;

          if (type === "text-delta" || type === "tool-input-delta") {
            const key = keyFor(part);
            let deduper = dedupers.get(key);
            if (!deduper) {
              deduper = new DeltaDeduper();
              dedupers.set(key, deduper);
            }
            lastPart.set(key, part);

            for (const delta of deduper.push(part.delta ?? "")) {
              controller.enqueue(rebuild(part, delta));
            }
            return;
          }

          // Closing marker: release anything still held for that id, in order,
          // before the end part itself goes out.
          if (type === "text-end" || type === "tool-input-end") {
            const deltaType =
              type === "text-end" ? "text-delta" : "tool-input-delta";
            const key = `${deltaType}:${part.id ?? ""}`;
            const deduper = dedupers.get(key);
            const template = lastPart.get(key);

            if (deduper && template) {
              for (const delta of deduper.flush()) {
                controller.enqueue(rebuild(template, delta));
              }
            }
            dedupers.delete(key);
            lastPart.delete(key);
          }

          controller.enqueue(part);
        },

        flush(controller) {
          // A truncated stream can end without its markers. Don't drop content.
          for (const [key, deduper] of dedupers) {
            const template = lastPart.get(key);
            if (!template) continue;
            for (const delta of deduper.flush()) {
              controller.enqueue(rebuild(template, delta));
            }
          }
          dedupers.clear();
          lastPart.clear();
        },
      });

      return {
        stream: (stream as ReadableStream<DeltaPart>).pipeThrough(repair),
        ...rest,
      } as Awaited<ReturnType<typeof doStream>>;
    },
  };
}
