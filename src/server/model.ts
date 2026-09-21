/**
 * Every model call in the app goes through this file.
 *
 * Keeping the provider behind one module means swapping the LLM is a one-file
 * change rather than a refactor — relevant because the assignment explicitly
 * allows an external LLM, and because Llama 3.3's tool-calling is good but not
 * frontier-grade. See docs/DECISIONS.md for why Workers AI is the default.
 */

import type {
  EmbeddingModel,
  LanguageModel,
  TranscriptionModel,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";

/**
 * Llama 3.3 70B, fp8-quantised for speed.
 *
 * Chosen over the other Workers AI text models because the agent loop needs
 * *both* streaming and function calling, and this one supports both. Its
 * limitation is a 24 000-token context window, which is why the transcript is
 * summarised rather than replayed in full — see `memory.ts`.
 */
export const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** 768-dimensional embeddings; must match the Vectorize index dimensions. */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;

/** Speech-to-text for the push-to-talk button. */
export const TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Hard ceiling from the model card. We budget well under it. */
export const CHAT_CONTEXT_TOKENS = 24_000;

/**
 * Build the provider, routing through AI Gateway when one is configured.
 *
 * The gateway is deliberately optional: an unset `AI_GATEWAY_ID` calls Workers
 * AI directly, so nobody has to create a gateway on their account just to run
 * this project. When it *is* set, every call gains caching, request logs and
 * analytics for free.
 */
function provider(env: Env) {
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  return createWorkersAI({
    binding: env.AI,
    ...(gatewayId ? { gateway: { id: gatewayId } } : {}),
  });
}

/**
 * The conversational model.
 *
 * @param sessionAffinity - Pass the agent's `this.sessionAffinity` so every
 * turn from one learner lands on the same backend replica. The KV prefix cache
 * then hits on the shared system prompt and history instead of re-reading it
 * cold each turn.
 */
// Return types are annotated with the AI SDK's own interfaces rather than left
// to inference. The provider's concrete classes carry private members, which
// TypeScript refuses to name in an emitted declaration — and these are the
// types `streamText`, `embedMany` and `transcribe` accept anyway.

export function chatModel(env: Env, sessionAffinity?: string): LanguageModel {
  return provider(env).chat(CHAT_MODEL, {
    ...(sessionAffinity ? { sessionAffinity } : {}),
  });
}

export function embeddingModel(env: Env): EmbeddingModel {
  return provider(env).textEmbeddingModel(EMBEDDING_MODEL);
}

export function transcriptionModel(env: Env): TranscriptionModel {
  return provider(env).transcription(TRANSCRIPTION_MODEL);
}

/**
 * Rough token estimate for context budgeting.
 *
 * ~4 characters per token is the usual English approximation. This only ever
 * decides *how much history to include*, so being off by 10% costs a little
 * headroom and nothing else — not worth shipping a real tokeniser to the edge.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
