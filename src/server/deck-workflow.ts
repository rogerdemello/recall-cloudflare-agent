/**
 * Durable deck generation.
 *
 * Asking one model call for "thirty cards on distributed systems" produces a
 * thin, repetitive deck and takes long enough that a transient failure loses
 * the lot. This splits the job: outline the topic, then generate each subtopic
 * independently, each as its own durable step.
 *
 * What that buys:
 *  - Steps are retried individually. One flaky inference doesn't restart the
 *    outline or re-do the subtopics that already succeeded.
 *  - Progress is reported as it happens, so the browser shows a real progress
 *    bar rather than a spinner.
 *  - The whole thing survives the Durable Object being evicted mid-run.
 *
 * Semantic deduplication is not done here — it lives in `StudyCoach.saveCards`,
 * so that cards mined from conversation get exactly the same treatment as cards
 * generated in bulk. One code path, one threshold.
 */

import type { WorkflowEvent } from "cloudflare:workers";
import { AgentWorkflow, type AgentWorkflowStep } from "agents/workflows";
import { generateText } from "ai";
import type { StudyCoach } from "./agent";
import { chatModel } from "./model";
import { parseCards, parseSubtopics, type ParsedCard } from "./parsing";

export interface DeckBuildParams {
  topic: string;
  cardCount: number;
}

export interface DeckProgress {
  step: string;
  done: number;
  total: number;
}

export interface DeckResult {
  topic: string;
  saved: number;
  skipped: number;
  subtopics: number;
}

/** Roughly this many cards per subtopic when deciding how to split a topic. */
const CARDS_PER_SUBTOPIC = 4;
const MIN_SUBTOPICS = 3;
const MAX_SUBTOPICS = 8;

export class DeckBuilder extends AgentWorkflow<
  StudyCoach,
  DeckBuildParams,
  DeckProgress
> {
  async run(
    event: Readonly<WorkflowEvent<DeckBuildParams>>,
    step: AgentWorkflowStep,
  ): Promise<DeckResult> {
    const { topic, cardCount } = event.payload;

    const wanted = clamp(
      Math.round(cardCount / CARDS_PER_SUBTOPIC),
      MIN_SUBTOPICS,
      MAX_SUBTOPICS,
    );

    // -- Step 1: break the topic into subtopics ----------------------------
    const subtopics = await step.do("outline", async () => {
      const { text } = await generateText({
        model: chatModel(this.env),
        system:
          "You plan study curricula. Given a topic, list the distinct " +
          "subtopics a learner must understand to know it well. Order them so " +
          "each builds on the last. Output one subtopic per line, no numbering, " +
          "no preamble, no commentary. Each line is a short noun phrase.",
        prompt: `Topic: ${topic}\nList exactly ${wanted} subtopics.`,
      });

      const parsed = parseSubtopics(text, wanted);
      // A deck with no subtopics would silently produce nothing. Fail the step
      // so the workflow engine retries the outline rather than "succeeding"
      // with an empty plan.
      if (parsed.length === 0) {
        throw new Error(`Could not parse any subtopics for "${topic}"`);
      }
      return parsed;
    });

    const total = subtopics.length + 1;
    await this.reportProgress({
      step: `Planned ${subtopics.length} subtopics`,
      done: 1,
      total,
    });

    // -- Step 2..n: generate and persist each subtopic ----------------------
    let saved = 0;
    let requested = 0;

    for (const [i, subtopic] of subtopics.entries()) {
      const perSubtopic = Math.max(
        2,
        Math.round(cardCount / subtopics.length),
      );

      let cards: ParsedCard[] = [];
      try {
        cards = await step.do(`generate-${i}`, async () => {
          const { text } = await generateText({
            model: chatModel(this.env),
            system:
              "You write flashcards. Each card tests one idea a learner should " +
              "be able to recall unprompted. Questions are specific and " +
              "answerable in a sentence or two; avoid yes/no questions and " +
              "avoid questions that quote your own phrasing back.\n\n" +
              "Output format, repeated, with nothing else:\n" +
              "Q: <question>\n" +
              "A: <answer>",
            prompt: `Topic: ${topic}\nSubtopic: ${subtopic}\nWrite ${perSubtopic} cards.`,
          });
          return parseCards(text, perSubtopic);
        });
      } catch (error) {
        // The step exhausted its retries. One weak subtopic is not worth
        // discarding the cards that already landed, so note it and carry on.
        console.error(`deck step generate-${i} failed for "${subtopic}"`, error);
        await this.reportProgress({
          step: `Skipped "${subtopic}"`,
          done: i + 2,
          total,
        });
        continue;
      }

      if (cards.length === 0) {
        await this.reportProgress({
          step: `No usable cards for "${subtopic}"`,
          done: i + 2,
          total,
        });
        continue;
      }

      requested += cards.length;

      // RPC back into the agent. Writing through the agent rather than
      // straight to storage keeps deduplication, vector indexing and the
      // review schedule in one place.
      const added = await step.do(`persist-${i}`, async () =>
        this.agent.saveDeckCards(topic, cards),
      );
      saved += added;

      await this.reportProgress({
        step: `Added ${added} cards on "${subtopic}"`,
        done: i + 2,
        total,
      });
    }

    const result: DeckResult = {
      topic,
      saved,
      skipped: requested - saved,
      subtopics: subtopics.length,
    };

    // Durable and idempotent — triggers onWorkflowComplete on the agent.
    await step.reportComplete(result);
    return result;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
