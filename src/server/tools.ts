/**
 * Tools the model can call during a turn.
 *
 * Two deliberate constraints shape this file:
 *
 *  - **Few and flat.** Llama 3.3 is a capable tool-caller but not a frontier
 *    model. Four tools with shallow argument shapes get called correctly far
 *    more often than a dozen with nested unions.
 *  - **Nothing correctness-critical lives here.** A tool call is a
 *    *probabilistic* branch, so anything whose absence would break the product
 *    is routed in code instead. Two things qualify: grading a learner's answer,
 *    and mining the conversation for flashcards. Both live in `agent.ts`.
 *
 * Card mining used to be an `add_cards` tool. It was removed after testing
 * against live Workers AI showed Llama 3.3 reliably produces *either* prose
 * *or* a tool call in a step, almost never both — so "explain the concept, then
 * silently save cards" simply never fired. It is now a separate extraction pass
 * after the turn, which is both more reliable and one less thing for the model
 * to forget.
 */

import { tool } from "ai";
import { z } from "zod";

/**
 * What a tool needs from the agent.
 *
 * An interface rather than the class itself, so tools and agent don't form an
 * import cycle. Deliberately narrow: it names only the capabilities the tools
 * actually invoke, not the agent's whole surface. That keeps `env`, `sql` and
 * the rest out of reach of tool code, which is exactly where they should stay.
 */
export interface ToolHost {
  saveCards(
    deck: string,
    cards: { question: string; answer: string }[],
    source: "chat" | "deck",
  ): Promise<number>;
  startDeckBuild(topic: string, cardCount: number): Promise<string>;
  beginReview(): Promise<boolean>;
  searchMemory(query: string): Promise<
    { deck: string; question: string; answer: string; score: number }[]
  >;
  progressReport(): {
    cardCount: number;
    dueCount: number;
    mastery: number;
    streakDays: number;
    reviewsCompleted: number;
    decks: { deck: string; cardCount: number; dueCount: number }[];
  };
  announceTool(name: string, label: string): void;
}

export interface ToolOptions {
  /**
   * Offer `build_deck` at all. Gated by the caller on the learner's own
   * wording, because the model starts deck builds unbidden otherwise.
   */
  allowDeckBuild?: boolean;
}

export function buildTools(host: ToolHost, options: ToolOptions = {}) {
  const always = alwaysOnTools(host);

  // Returning one of two concrete shapes, rather than spreading a possibly-empty
  // object, keeps `build_deck` from being inferred as `Tool | undefined` — which
  // the AI SDK's ToolSet index signature rejects.
  if (!options.allowDeckBuild) return always;

  return {
    ...always,
    build_deck: tool({
      description:
        "Generate a full study deck on a topic as a background job. The " +
        "learner has explicitly asked for a deck or a course.",
      inputSchema: z.object({
        topic: z.string().describe("The subject to build a deck for"),
        card_count: z
          .number()
          .int()
          .min(5)
          .max(40)
          .default(20)
          .describe("Roughly how many cards to aim for"),
      }),
      execute: async ({ topic, card_count }) => {
        host.announceTool("build_deck", `Building a deck on "${topic}"`);
        const workflowId = await host.startDeckBuild(topic, card_count);
        return {
          started: true,
          workflowId,
          note:
            "The deck is being built in the background and cards will appear " +
            "as they are generated. Tell the learner it is underway; do not " +
            "list cards yourself.",
        };
      },
    }),
  };
}

function alwaysOnTools(host: ToolHost) {
  return {
    search_memory: tool({
      description:
        "Search everything this learner has studied before, by meaning rather " +
        "than exact words. Use it when they ask what they have covered, when " +
        "they reference an earlier session, or before teaching something to " +
        "check whether they already know it.",
      inputSchema: z.object({
        query: z.string().describe("What to look for"),
      }),
      execute: async ({ query }) => {
        host.announceTool("search_memory", `Searching memory for "${query}"`);
        const hits = await host.searchMemory(query);
        if (hits.length === 0) {
          return { found: 0, cards: [], note: "Nothing on this topic yet." };
        }
        return {
          found: hits.length,
          cards: hits.map((h) => ({
            deck: h.deck,
            question: h.question,
            answer: h.answer,
          })),
        };
      },
    }),

    quiz_me: tool({
      description:
        "Start a review of the most overdue card right now. Use when the " +
        "learner asks to be tested, quizzed, or to review.",
      inputSchema: z.object({}),
      execute: async () => {
        host.announceTool("quiz_me", "Pulling up a card");
        const started = await host.beginReview();
        return started
          ? {
              started: true,
              note:
                "The question has been shown to the learner already. Do not " +
                "repeat it — say something brief and encouraging instead.",
            }
          : {
              started: false,
              note: "Nothing is due yet. Suggest learning something new instead.",
            };
      },
    }),

    get_progress: tool({
      description:
        "Look up how many cards the learner has, how many are due, their " +
        "mastery level and study streak.",
      inputSchema: z.object({}),
      execute: async () => {
        host.announceTool("get_progress", "Checking progress");
        const report = host.progressReport();
        return {
          ...report,
          masteryPercent: Math.round(report.mastery * 100),
        };
      },
    }),
  };
}

export type CoachTools = ReturnType<typeof buildTools>;
